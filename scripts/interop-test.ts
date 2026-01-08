import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Contract, Provider, Wallet, utils } from "zksync-js";
import { ethers } from "ethers";

import InteropCenterArtifact from "../deps/InteropCenter.json";
import InteropHandlerArtifact from "../deps/InteropHandler.json";

const L2_INTEROP_CENTER_ADDRESS = "0x0000000000000000000000000000000000010010";
const L2_INTEROP_HANDLER_ADDRESS = "0x000000000000000000000000000000000001000d";
const L2_INTEROP_ROOT_STORAGE = "0x0000000000000000000000000000000000010008";

const InteropRootStorageAbi = [
  "function interopRoots(uint256 chainId, uint256 batchNumber) view returns (bytes32)",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function loadArtifact(artifactPath: string) {
  const resolvedPath = path.resolve(__dirname, artifactPath);
  const raw = fs.readFileSync(resolvedPath, "utf-8");
  return JSON.parse(raw);
}

function encodeEvmV1Address(chainId: bigint, address: string): string {
  const version = ethers.getBytes("0x0001");
  const chainBytes = ethers.zeroPadValue(ethers.toBeHex(chainId), 6);
  const addressBytes = ethers.getBytes(address);
  return ethers.hexlify(ethers.concat([version, chainBytes, addressBytes]));
}

async function deployGreetContract(wallet: Wallet, artifact: any, initialGreeting = "hello") {
  const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
  const factory = new ethers.ContractFactory(artifact.abi, bytecode, wallet);
  const contract = await factory.deploy(initialGreeting);
  await contract.waitForDeployment();
  return contract;
}

async function waitUntilRootBecomesAvailable(
  provider: Provider,
  chainId: bigint,
  batchNumber: number,
  expectedRoot: string
) {
  const contract = new Contract(L2_INTEROP_ROOT_STORAGE, InteropRootStorageAbi, provider);
  const POLL_INTERVAL = 100;
  const DEFAULT_TIMEOUT = 60_000;
  let retries = Math.floor(DEFAULT_TIMEOUT / POLL_INTERVAL);

  while (retries > 0) {
    let root: string | null;
    try {
      root = await contract.interopRoots(chainId, batchNumber);
    } catch {
      root = null;
    }

    if (root && root !== ethers.ZeroAddress && root !== `0x${"00".repeat(32)}`) {
      if (root.toLowerCase() === expectedRoot.toLowerCase()) {
        return;
      }
      throw new Error(`Interop root mismatch: expected ${expectedRoot}, got ${root}`);
    }

    retries -= 1;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }

  throw new Error("Interop root did not become available in time");
}

async function waitUntilBlockFinalized(provider: Provider, blockNumber: number) {
  const POLL_INTERVAL = 100;
  const DEFAULT_TIMEOUT = 60_000;
  let retries = Math.floor(DEFAULT_TIMEOUT / POLL_INTERVAL);

  while (retries > 0) {
    let executedBlock = 0;
    try {
      const block = await provider.getBlock("finalized");
      executedBlock = block?.number ?? 0;
    } catch {
      executedBlock = 0;
    }

    if (executedBlock >= blockNumber) {
      return;
    }

    retries -= 1;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }

  throw new Error("Block was not finalized in time");
}

async function waitForL2ToL1LogProof(provider: Provider, blockNumber: number, txHash: string) {
  await waitUntilBlockFinalized(provider, blockNumber);

  while ((await provider.getLogProof(txHash, 0)) == null) {
    await utils.sleep(provider.pollingInterval);
  }
}

async function main() {
  const PRIVATE_KEY = requireEnv("PRIVATE_KEY");
  const L2_RPC_URL = requireEnv("L2_RPC_URL");
  const L2_RPC_URL_SECOND = requireEnv("L2_RPC_URL_SECOND");

  const GREET_ARTIFACT = process.env.GREET_ARTIFACT ?? "../deps/Greet.json";

  const greetArtifact = loadArtifact(GREET_ARTIFACT);

  const providerA = new Provider(L2_RPC_URL);
  const providerB = new Provider(L2_RPC_URL_SECOND);

  const walletA = new Wallet(PRIVATE_KEY, providerA);
  const walletB = new Wallet(PRIVATE_KEY, providerB);

  console.log("Wallet:", walletA.address);

  const greetContract = await deployGreetContract(walletB, greetArtifact, "gm");
  const greetAddress = await greetContract.getAddress();
  console.log("Greet deployed at:", greetAddress);

  const interopCenter = new Contract(L2_INTEROP_CENTER_ADDRESS, InteropCenterArtifact.abi, walletA);

  const destinationChainId = BigInt((await providerB.getNetwork()).chainId);
  const recipient = encodeEvmV1Address(destinationChainId, greetAddress);

  const greetIface = new ethers.Interface(["function setGreeting(string)"]);
  const payload = greetIface.encodeFunctionData("setGreeting", ["hello from source"]);
  const attributes: string[] = [];

  const sendTx = await interopCenter.sendMessage(recipient, payload, attributes, {
    gasLimit: 1_000_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  const sendReceipt = await sendTx.wait();
  if (!sendReceipt) {
    throw new Error("Missing receipt for sendMessage transaction");
  }

  console.log("sendMessage tx:", sendReceipt.hash, "block:", sendReceipt.blockNumber);

  const interopIface = new ethers.Interface(InteropCenterArtifact.abi);
  const bundleEvent = (sendReceipt.logs ?? [])
    .map((log) => {
      try {
        return interopIface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "InteropBundleSent");

  if (!bundleEvent) {
    throw new Error("InteropBundleSent event not found in receipt logs.");
  }

  const interopBundle = bundleEvent.args.interopBundle;
  const bundleType =
    "tuple(bytes1 version,uint256 sourceChainId,uint256 destinationChainId,bytes32 interopBundleSalt," +
    "tuple(bytes1 version,bool shadowAccount,address to,address from,uint256 value,bytes data)[] calls," +
    "tuple(bytes executionAddress,bytes unbundlerAddress) bundleAttributes)";
  const bundleBytes = ethers.AbiCoder.defaultAbiCoder().encode([bundleType], [interopBundle]);

  await waitForL2ToL1LogProof(providerA, sendReceipt.blockNumber, sendReceipt.hash);
  const logProof = await providerA.getLogProof(sendReceipt.hash, 0);
  if (!logProof) {
    throw new Error("Missing log proof for sendMessage transaction");
  }

  const logIndex = Number(logProof.id);
  const l2ToL1Log = sendReceipt.l2ToL1Logs?.[logIndex] ?? sendReceipt.l2ToL1Logs?.[0];
  if (!l2ToL1Log) {
    throw new Error("Missing L2->L1 log in receipt; adjust log index selection.");
  }

  const proof = {
    chainId: BigInt((await providerA.getNetwork()).chainId),
    l1BatchNumber: logProof.batch_number,
    l2MessageIndex: logProof.id,
    message: {
      txNumberInBatch: sendReceipt.index,
      sender: l2ToL1Log.sender,
      data: l2ToL1Log.data,
    },
    proof: logProof.proof,
  };

  await waitUntilRootBecomesAvailable(
    providerB,
    BigInt((await providerA.getNetwork()).chainId),
    logProof.batch_number,
    logProof.root
  );

  const interopHandler = new Contract(L2_INTEROP_HANDLER_ADDRESS, InteropHandlerArtifact.abi, walletB);

  const execTx = await interopHandler.executeBundle(bundleBytes, proof, {
    gasLimit: 1_000_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  const execReceipt = await execTx.wait();
  console.log("executeBundle tx:", execReceipt?.hash);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

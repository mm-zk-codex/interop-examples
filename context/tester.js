const zksync = require('zksync-ethers');
const ethers = require('ethers');

// ---- constants ----

// Fixed system contract on zkSync L2
const L1_MESSENGER_ADDRESS = '0x0000000000000000000000000000000000008008';
const L2_MESSAGE_VERIFICATION_ADDRESS = '0x0000000000000000000000000000000000010009';
const INTEROP_CENTER_ADDRESS = '0x0000000000000000000000000000000000010010';

const MessageVerification = require('./MessageVerification.json');
const Greet = require('./Greet.json');
const InteropCenter = require("./InteropCenter.json");


// Address of the contract with interopRoots mapping (to be populated)
const L2_INTEROP_ROOT_STORAGE = '0x0000000000000000000000000000000000010008'; // TODO: set actual address

const InteropRootStorageAbi = [
  'function interopRoots(uint256 chainId, uint256 batchNumber) view returns (bytes32)'
];
// Wait until the interop root for (chainId, batchNumber) becomes available and matches expected root
async function waitUntilRootBecomesAvailable(wallet, chainId, batchNumber, expectedRoot) {
  const contract = new zksync.Contract(L2_INTEROP_ROOT_STORAGE, InteropRootStorageAbi, wallet.provider);
  const POLL_INTERVAL = 100; // ms
  const DEFAULT_TIMEOUT = 60_000; // ms (1 minute)
  let retries = Math.floor(DEFAULT_TIMEOUT / POLL_INTERVAL);
  while (retries > 0) {
    let root;
    try {
      root = await contract.interopRoots(chainId, batchNumber);
    } catch (e) {
      root = null;
    }
    if (root && root !== ethers.ZeroAddress && root !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      if (root.toLowerCase() === expectedRoot.toLowerCase()) {
        return;
      } else {
        throw new Error(`Interop root mismatch: expected ${expectedRoot}, got ${root}`);
      }
    }
    retries -= 1;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }
  throw new Error('Interop root did not become available in time');
}

const IL1MessengerAbi = [
  'function sendToL1(bytes _message) external returns (bytes32)'
];

// ---- helpers ----

async function deployGreetContract(wallet, initialGreeting = 'hello') {
  // ethers ContractFactory
  const factory = new ethers.ContractFactory(Greet.abi, Greet.bytecode.object, wallet);
  const contract = await factory.deploy(initialGreeting);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  return { contract, address };
}

async function waitUntilBlockFinalized(wallet, blockNumber) {
  console.log('Waiting for block to be finalized...', blockNumber);
  // Similar to Rust: poll for finalized block, with retries and interval
  const POLL_INTERVAL = 100; // ms
  const DEFAULT_TIMEOUT = 60_000; // ms (1 minute)
  let retries = Math.floor(DEFAULT_TIMEOUT / POLL_INTERVAL);
  while (retries > 0) {
    // 'finalized' block is mapped to the latest executed block
    let executedBlock;
    try {
      const block = await wallet.provider.getBlock('finalized');
      executedBlock = block ? block.number : 0;
    } catch (e) {
      executedBlock = 0;
    }
    if (executedBlock >= blockNumber) {
      // Block is finalized
      return;
    } else {
      // Optionally log debug info
      // console.debug(`Block not finalized yet: executedBlock=${executedBlock}, expected=${blockNumber}`);
      retries -= 1;
      await new Promise((res) => setTimeout(res, POLL_INTERVAL));
    }
  }
  throw new Error('Block was not finalized in time');
}

async function waitForL2ToL1LogProof(wallet, blockNumber, txHash) {
  // First, we wait for block to be finalized.
  await waitUntilBlockFinalized(wallet, blockNumber);

  // Second, we wait for the log proof.
  while ((await wallet.provider.getLogProof(txHash, 0)) == null) {
    // console.log('Waiting for log proof...');
    await zksync.utils.sleep(wallet.provider.pollingInterval);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

// ---- main ----

async function main() {
  const PRIVATE_KEY = requireEnv('PRIVATE_KEY');
  const L2_RPC_URL = requireEnv('L2_RPC_URL');
  const L2_RPC_URL_SECOND = requireEnv('L2_RPC_URL_SECOND');

  const providerA = new zksync.Provider(L2_RPC_URL);
  const providerB = new zksync.Provider(L2_RPC_URL_SECOND);

  const walletA = new zksync.Wallet(PRIVATE_KEY, providerA);
  const walletB = new zksync.Wallet(PRIVATE_KEY, providerB);

  const ethersWalletA = new ethers.Wallet(PRIVATE_KEY, providerA);
  const ethersWalletB = new ethers.Wallet(PRIVATE_KEY, providerB);

  console.log('Wallet address:', walletA.address);

  // ---- Test interop type B ----

  // Create a contract on the destination chain.

  const { address: greetAddressOnB } = await deployGreetContract(ethersWalletB, 'gm');
  console.log('Greet deployed at:', greetAddressOnB);


  const interopCenter = new zksync.Contract(
    INTEROP_CENTER_ADDRESS,
    InteropCenter.abi,
    ethersWalletA
  );

  {

    const recipient = "0x000100000219a614e441CF0795aF14DdB9f7984Da85CD36DB1B8790d";
    const payload = "0xa41368620000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c68656c6c6f2046726f6d20410000000000000000000000000000000000000000";
    const attributes = [];


    const tx = await interopCenter.sendMessage(recipient, payload, attributes, {
      gasLimit: 1_000_000n,
      maxFeePerGas: 1_000_000_000n,        // pick a non-zero value your node accepts
      maxPriorityFeePerGas: 0n,
    });

    console.log('Tx hash:', tx.hash);

    const receipt = await tx.wait();
    console.log('Tx mined in block:', receipt.blockNumber);
    console.log(receipt);
  }

  console.log("!!! Interop B message sent.");






  // ---- send L2 -> L1 message ----



  const messenger = new zksync.Contract(
    L1_MESSENGER_ADDRESS,
    IL1MessengerAbi,
    // Must be ethers wallet to avoid sending Era-specific txs
    new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(L2_RPC_URL))
  );

  console.log('Sending L2 → L1 message...');

  const feeData = await messenger.runner.provider.getFeeData();

  // Pick something non-zero; if your chain minimum is > 1 wei, bump these.
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1n;
  const maxFeePerGas = feeData.maxFeePerGas ?? (maxPriorityFeePerGas + 1n);

  console.log('Max fee per gas:', maxFeePerGas.toString());
  console.log('Max priority fee per gas:', maxPriorityFeePerGas.toString());

  const data = ethers.toUtf8Bytes("hello interop");

  // If estimateGas works:
  const gasLimit = await messenger.sendToL1.estimateGas(data);

  const tx = await messenger.sendToL1(data, {
    gasLimit: gasLimit * 2n,
    maxFeePerGas: 1_000_000_000n,        // pick a non-zero value your node accepts
    maxPriorityFeePerGas: 0n,
  });

  console.log('Tx hash:', tx.hash);

  const receipt = await tx.wait();
  console.log('Tx mined in block:', receipt.blockNumber);
  console.log(receipt);

  // ---- wait for proof availability ----

  console.log('Waiting for L2 → L1 log proof...');
  await waitForL2ToL1LogProof(
    walletA,
    receipt.blockNumber,
    tx.hash
  );

  const logProof = await walletA.provider.getLogProof(tx.hash, 0);
  console.log(logProof);

  console.log('Proof obtained');
  console.log('L1 batch:', logProof.batch_number);
  console.log('Message index:', logProof.id);

  // ---- verify proof on second L2 ----

  console.log('Waiting for interop root to become available on second chain...');
  await waitUntilRootBecomesAvailable(
    walletB,
    (await providerA.getNetwork()).chainId,
    logProof.batch_number,
    logProof.root
  );

  const verifier = new zksync.Contract(
    L2_MESSAGE_VERIFICATION_ADDRESS,
    MessageVerification,
    providerB
  );

  console.log('Verifying proof on second chain...');

  const included =
    await verifier.proveL2MessageInclusionShared(
      (await providerA.getNetwork()).chainId,
      logProof.batch_number,
      logProof.id,
      {
        txNumberInBatch: receipt.index,
        sender: receipt.from,
        data: ethers.toUtf8Bytes('hello interop')
      },
      logProof.proof
    );

  console.log('Message inclusion result:', included);

  if (!included) {
    throw new Error('Message was NOT included');
  }

  console.log('✅ Interop verification successful');
}



main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});

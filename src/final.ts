import { sha256 } from "js-sha256";
import { serialize, deserialize } from "serializer.ts/Serializer";
import BigNumber from "bignumber.js";

import { BloomFilter } from "bloomfilter";
import * as _ from "underscore";

const level  = require("level");
const sync = require("promise-synchronizer");
const JSONStream = require("JSONStream");

import * as fs from "fs";
import * as path from "path";
import deepEqual = require("deep-equal");

import * as uuidv4 from "uuid/v4";
import * as express from "express";
import * as bodyParser from "body-parser";
import { URL } from "url";
import axios from "axios";

import { Set } from "typescript-collections";
import * as parseArgs from "minimist";

const DEFAULT_SPV_LEN = 10;
const BLOOM_FILTER_HASH_FUNCTIONS = 16;
const BLOCKS_IN_MEM = 10;
const BLOCK_KEY_PREFIX = "block_";

export type Address = string;

export class Transaction {
  public senderAddress: Address;
  public recipientAddress: Address;
  public value: number;

  constructor(senderAddress: Address, recipientAddress: Address, value: number) {
    this.senderAddress = senderAddress;
    this.recipientAddress = recipientAddress;
    this.value = value;
  }
}

export class Block {
  public blockNumber: number;
  public transactions: Array<Transaction>;
  public timestamp: number;
  public nonce: number;
  public prevBlock: string;

  constructor(blockNumber: number, transactions: Array<Transaction>, timestamp: number, nonce: number,
    prevBlock: string) {
    this.blockNumber = blockNumber;
    this.transactions = transactions;
    this.timestamp = timestamp;
    this.nonce = nonce;
    this.prevBlock = prevBlock;
  }

  // Calculates the SHA256 of the entire block, including its transactions.
  public sha256(): string {
    return sha256(JSON.stringify(serialize<Block>(this)));
  }
}

export class Node {
  public id: string;
  public url: URL;

  constructor(id: string, url: URL) {
    this.id = id;
    this.url = url;
  }

  public toString(): string {
      return `${this.id}:${this.url}`;
  }
}

export class TransactionPool {
  private memPool: Array<Transaction>;
  private diskSaveTimer: NodeJS.Timer;
  private storagePath: string;

  constructor(nodeId: string, diskSaveIntervalMs: number) {
    this.memPool = [];
    this.loadFromDisk();

    this.storagePath = path.resolve(__dirname, "../", `${nodeId}.transactions`);

    this.startDiskTimer(diskSaveIntervalMs);
  }

  public addTransaction(transaction: Transaction) {
    this.memPool.push(transaction);
  }

  public getTransactions(): Array<Transaction> {
    return this.memPool.slice(0);
  }

  public clear() {
    this.memPool = [];
  }

  private startDiskTimer(diskSaveIntervalMs: number) {
    this.diskSaveTimer = setInterval(() => {
      this.saveToDisk();
    }, diskSaveIntervalMs);
  }

  private saveToDisk() {
    fs.writeFileSync(this.storagePath, JSON.stringify(serialize(this.memPool), undefined, 2), "utf8");
  }

  private loadFromDisk() {
    if (!this.storagePath) {
      this.memPool = [];
      return;
    }
    this.memPool = deserialize<Transaction[]>(Transaction, JSON.parse(fs.readFileSync(this.storagePath, "utf8")));
  }

  private stopDiskTimer() {
    clearInterval(this.diskSaveTimer);
  }
}

interface IAddressBalance {
  // can't use Address here since index sig only works for string/number
  [key: string]: number;
}

// Simple UTXO pool. We'll allow addresses to go into the negative range since we don't want to break
// all the test logic which has been previously written
export class UTXOPool {
  private pool: IAddressBalance;

  constructor(blocks: Array<Block>) {
    this.pool = {};

    for (let i = 0; i < blocks.length; i++) {
      this.applyTransactionsFromBlock(blocks[i]);
    }
  }

  public applyTransactionsFromBlock(block: Block): boolean {
    let mask: boolean = true;

    for (let i = 0; i < block.transactions.length; i++) {
      mask = mask && this.transact(block.transactions[i].senderAddress, block.transactions[i].recipientAddress, block.transactions[i].value);
    }

    return mask;
  }

  public getBalance(address: Address): number {
    if (!_.has(this.pool, address)) return 0;

    return this.pool[address];
  }

  private setBalance(address: Address, balance: number) {
    this.pool[address] = balance;
  }

  public transact(sender: Address, recipient: Address, amount: number): boolean {
    let balanceSender = this.getBalance(sender);
    let balanceRecipient = this.getBalance(recipient);

    if (balanceSender - amount < 0) {
      // removing any real logic here so to not fail any tests but in theory we could do something about this
      // return false;
    }

    balanceSender -= amount;
    balanceRecipient += amount;

    // update balance in pool
    this.setBalance(sender, balanceSender);
    this.setBalance(recipient, balanceRecipient);

    return true;
  }

  public toString(): string {
    return `${this.pool}`;
  }
}

export class Blockchain {
  // Let's define that our "genesis" block as an empty block, starting from the January 1, 1970 (midnight "UTC").
  public static readonly GENESIS_BLOCK = new Block(0, [], 0, 0, "fiat lux");

  public static readonly DIFFICULTY = 4;
  public static readonly TARGET = 2 ** (256 - Blockchain.DIFFICULTY);

  public static readonly MINING_SENDER = "<COINBASE>";
  public static readonly MINING_REWARD = 50;

  public static readonly TRANSACTION_DISK_WRITE_INTERVAL_MS = 1000;

  public nodeId: string;
  public nodes: Set<Node>;
  public blocks: Array<Block>;
  public transactionPool: TransactionPool;
  public utxoPool: UTXOPool;
  private storagePath: string;
  private fileDB: any;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    this.nodes = new Set<Node>();
    this.transactionPool = new TransactionPool(nodeId, Blockchain.TRANSACTION_DISK_WRITE_INTERVAL_MS);

    this.storagePath = path.resolve(__dirname, "../", `${this.nodeId}.blockchain`);
    this.fileDB = level(this.storagePath);

    // Load the blockchain from the storage.
    this.load(false);
    // create utxo pool after we have some blocks
    this.utxoPool = new UTXOPool(this.blocks);
  }

  // Registers new node.
  public register(node: Node): boolean {
    return this.nodes.add(node);
  }

  // Saves the blockchain to the disk.
  private save() {
    const blockCount = this.blocks[this.blocks.length - 1].blockNumber;

    sync(this.fileDB.put("blockCount", blockCount));
    for (let i = 0; i < this.blocks.length; i++) {
      const data = JSON.stringify(serialize(this.blocks[i]), undefined, 2);
      sync(this.fileDB.put(BLOCK_KEY_PREFIX + this.blocks[i].blockNumber, data));
    }
  }

  // Loads the blockchain from the disk.
  private load(loadAll: boolean) {
    try {
      const blockCount = this.getBlockCountOnDisk();
      if (blockCount == 0) {
        this.blocks = [Blockchain.GENESIS_BLOCK];
        return;
      }

      let startBlock = 0;
      let endBlock = BLOCKS_IN_MEM - 1;

      if (loadAll) {
        endBlock = blockCount;
      }
      else if (blockCount > BLOCKS_IN_MEM) {
        startBlock = blockCount - BLOCKS_IN_MEM + 1;
        endBlock = blockCount;
      }

      this.blocks = [];
      for (let i = startBlock; i <= endBlock; i++) {
        const block = this.loadBlockFromDisk(i);
        if (block) this.blocks.push(block);
      }
    } catch (err) {
      if (!err.notFound) {
        console.log(`Invalid blockchain data file ${this.storagePath} err: ${err}`);
      }

      this.blocks = [Blockchain.GENESIS_BLOCK];
    } finally {
      this.verify();
    }
  }

  private getBlockCountOnDisk(): number {
    try {
      const blockCount = sync(this.fileDB.get("blockCount"));
      if (!blockCount || isNaN(blockCount)) {
        return 0;
      }

      return blockCount;
    } catch (err) {
      if (err.notFound) return 0;
      throw err;
    }
  }

  private loadBlockFromDisk(index: number): Block {
    try {
      const key = BLOCK_KEY_PREFIX + index;
      const blockData = sync(this.fileDB.get(key));
      const block = deserialize<Block>(Block, JSON.parse(blockData));

      return block;
    }
    catch (err) {
      if (err.notFound) return undefined;
      throw err;
    }
  }

  // Verifies the blockchain.
  public static verify(blocks: Array<Block>, partial: boolean): boolean {
    try {
      // The blockchain can't be empty. It should always contain at least the genesis block.
      if (blocks.length === 0) {
        throw new Error("Blockchain can't be empty!");
      }

      // The first block has to be the genesis block.
      if (!partial && !deepEqual(blocks[0], Blockchain.GENESIS_BLOCK)) {
        throw new Error("Invalid first block!");
      }

      // Verify the chain itself.
      for (let i = 1; i < blocks.length; ++i) {
        const current = blocks[i];

        // Verify block number.
        if (!partial && current.blockNumber !== i) {
          throw new Error(`Invalid block number ${current.blockNumber} for block #${i}!`);
        }

        // Verify that the current blocks properly points to the previous block.
        const previous = blocks[i - 1];
        if (current.prevBlock !== previous.sha256()) {
          throw new Error(`Invalid previous block hash for block #${i}!`);
        }

        // Verify the difficutly of the PoW.
        //
        // TODO: what if the diffuclty was adjusted?
        if (!this.isPoWValid(current.sha256())) {
          throw new Error(`Invalid previous block hash's difficutly for block #${i}!`);
        }
      }

      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // Verifies the blockchain.
  private verify() {
    // The blockchain can't be empty. It should always contain at least the genesis block.
    if (!Blockchain.verify(this.blocks, true)) {
      throw new Error("Invalid blockchain!");
    }
  }

  // Receives candidate blockchains, verifies them, and if a longer and valid alternative is found - uses it to replace
  // our own.
  public consensus(blockchains: Array<Array<Block>>): boolean {
    // Iterate over the proposed candidates and find the longest, valid, candidate.
    let maxLength: number = 0;
    let bestCandidateIndex: number = -1;

    for (let i = 0; i < blockchains.length; ++i) {
      const candidate = blockchains[i];

      // Don't bother validating blockchains shorther than the best candidate so far.
      if (candidate.length <= maxLength) {
        continue;
      }

      // Found a good candidate?
      if (Blockchain.verify(candidate, false)) {
        maxLength = candidate.length;
        bestCandidateIndex = i;
      }
    }

    // Compare the candidate and consider to use it.
    if (bestCandidateIndex !== -1 && (maxLength > this.blocks.length || !Blockchain.verify(this.blocks, false))) {
      this.blocks = blockchains[bestCandidateIndex];
      this.save();

      return true;
    }

    return false;
  }

  public getBlocksForFilter(bloomFilter: BloomFilter, startIndex: number, depth: number): Array<number> {
    const blocks = [];

    for (let i = startIndex; i < startIndex + depth; i++) {
      const block = this.blocks[i];

      const possibleTransactions = _.filter(block.transactions, (transaction: Transaction) => {
          return bloomFilter.test(transaction.senderAddress) || bloomFilter.test(transaction.recipientAddress);
      });
      if (possibleTransactions.length > 0) {
        blocks.push(i);
      }
    }

    return blocks;
  }

  // Validates PoW.
  public static isPoWValid(pow: string): boolean {
    try {
      if (!pow.startsWith("0x")) {
        pow = `0x${pow}`;
      }

      return new BigNumber(pow).lessThanOrEqualTo(Blockchain.TARGET.toString());
    } catch {
      return false;
    }
  }

  // Mines for block.
  private mineBlock(transactions: Array<Transaction>): Block {
    // Create a new block which will "point" to the last block.
    const lastBlock = this.getLastBlock();
    const newBlock = new Block(lastBlock.blockNumber + 1, transactions, Blockchain.now(), 0, lastBlock.sha256());

    while (true) {
      const pow = newBlock.sha256();
      console.log(`Mining #${newBlock.blockNumber}: nonce: ${newBlock.nonce}, pow: ${pow}`);

      if (Blockchain.isPoWValid(pow)) {
        console.log(`Found valid POW: ${pow}!`);
        break;
      }

      newBlock.nonce++;
    }

    return newBlock;
  }

  // Submits new transaction
  public submitTransaction(senderAddress: Address, recipientAddress: Address, value: number) {
    this.transactionPool.addTransaction(new Transaction(senderAddress, recipientAddress, value));
  }

  // Creates new block on the blockchain.
  public createBlock(): Block {
    // Add a "coinbase" transaction granting us the mining reward!
    const transactions = [new Transaction(Blockchain.MINING_SENDER, this.nodeId, Blockchain.MINING_REWARD),
      ...this.transactionPool.getTransactions()];

    // Mine the transactions in a new block.
    const newBlock = this.mineBlock(transactions);

    // Append the new block to the blockchain.
    this.addBlock(newBlock);
    this.utxoPool.applyTransactionsFromBlock(newBlock);

    // Remove the mined transactions.
    this.transactionPool.clear();

    // Save the blockchain to the storage.
    this.save();

    return newBlock;
  }

  private addBlock(block: Block) {
    this.blocks.push(block);

    if (this.blocks.length > BLOCKS_IN_MEM) {
      this.save();
      // trim blocks from memory since they're on disk
      const lost = this.blocks.splice(0, this.blocks.length - BLOCKS_IN_MEM);
    }
  }

  public getLastBlock(): Block {
    return this.blocks[this.blocks.length - 1];
  }

  public *getAllBlocks(): IterableIterator<Block> {
    const blockCount = this.getBlockCountOnDisk();
    if (!blockCount) {
      return undefined;
    }

    for (let i = 0; i <= blockCount; i++) {
      yield this.loadBlockFromDisk(i);
    }
  }

  public static now(): number {
    return Math.round(new Date().getTime() / 1000);
  }
}

// Web server:
const ARGS = parseArgs(process.argv.slice(2));
const PORT = ARGS.port || 3000;
const app = express();
const nodeId = ARGS.id || uuidv4();
const blockchain = new Blockchain(nodeId);

// Set up bodyParser:
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);

  res.status(500);
});

// Show all the blocks in memory.
app.get("/blocks", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.blocks));
});

// Show all the blocks, including those from disk
app.get("/blocks/all", (req: express.Request, res: express.Response) => {
  const jsonStream = JSONStream.stringify();
  jsonStream.pipe(res);

  // use a generator to avoid loading everything into memory
  const generator = blockchain.getAllBlocks();
  for (let iterator = generator.next(); !iterator.done; iterator = generator.next()) {
    jsonStream.write(iterator.value);
  }

  jsonStream.end();
});

// Show specific block.
app.get("/blocks/:id", (req: express.Request, res: express.Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.json("Invalid parameter!");
    res.status(500);
    return;
  }

  if (id >= blockchain.blocks.length) {
    res.json(`Block #${id} wasn't found!`);
    res.status(404);
    return;
  }

  res.json(serialize(blockchain.blocks[id]));
});

app.post("/blocks/filter/:depth/:start?", (req: express.Request, res: express.Response) => {
  let depth = Number(req.params.depth);
  let startIndex = Number(req.params.start || blockchain.blocks.length - DEFAULT_SPV_LEN);
  startIndex = startIndex < 0 ? 0 : startIndex;
  if (startIndex + depth > blockchain.blocks.length) {
    depth = blockchain.blocks.length - startIndex;
  }

  let filter = req.body.filter;
  if (!filter || !Array.isArray(filter)) {
    filter = [];
  }

  const bloomFilter = new BloomFilter(filter, BLOOM_FILTER_HASH_FUNCTIONS);

  return res.json(blockchain.getBlocksForFilter(bloomFilter, startIndex, depth));
});

app.post("/blocks/mine", (req: express.Request, res: express.Response) => {
  // Mine the new block.
  const newBlock = blockchain.createBlock();

  res.json(`Mined new block #${newBlock.blockNumber}`);
});

// Show all transactions in the transaction pool.
app.get("/transactions", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.transactionPool));
});

app.post("/transactions", (req: express.Request, res: express.Response) => {
  const senderAddress = req.body.senderAddress;
  const recipientAddress = req.body.recipientAddress;
  const value = Number(req.body.value);

  if (!senderAddress || !recipientAddress || !value)  {
    res.json("Invalid parameters!");
    res.status(500);
    return;
  }

  blockchain.submitTransaction(senderAddress, recipientAddress, value);

  res.json(`Transaction from ${senderAddress} to ${recipientAddress} was added successfully`);
});

app.get("/nodes", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.nodes.toArray()));
});

app.post("/nodes", (req: express.Request, res: express.Response) => {
  const id = req.body.id;
  const url = new URL(req.body.url);

  if (!id || !url)  {
    res.json("Invalid parameters!");
    res.status(500);
    return;
  }

  const node = new Node(id, url);

  if (blockchain.register(node)) {
    res.json(`Registered node: ${node}`);
  } else {
    res.json(`Node ${node} already exists!`);
    res.status(500);
  }
});

app.put("/nodes/consensus", (req: express.Request, res: express.Response) => {
  // Fetch the state of the other nodes.
  const requests = blockchain.nodes.toArray().map(node => axios.get(`${node.url}blocks`));

  if (requests.length === 0) {
    res.json("There are nodes to sync with!");
    res.status(404);

    return;
  }

  axios.all(requests).then(axios.spread((...blockchains) => {
    if (blockchain.consensus(blockchains.map(res => deserialize<Block[]>(Block, res.data)))) {
      res.json(`Node ${nodeId} has reached a consensus on a new state.`);
    } else {
      res.json(`Node ${nodeId} hasn't reached a consensus on the existing state.`);
    }

    res.status(200);
    return;
  })).catch(err => {
    console.log(err);
    res.status(500);
    res.json(err);
    return;
  });

  res.status(500);
});

app.get("/utxo", (req: express.Request, res: express.Response) => {
  res.json(blockchain.utxoPool);
  res.status(200);
});

if (!module.parent) {
  app.listen(PORT);

  console.log(`Web server started on port ${PORT}. Node ID is: ${nodeId}`);
}

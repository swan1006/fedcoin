'use strict';

// Sahil Gupta

/*
todo = to do now
future = to do later
could = to do much later
*/

const crypto = require('crypto');
const cryptico = require('cryptico-js');
const NodeRSA = require('node-rsa');
const fastRoot = require('merkle-lib/fastRoot');
const blockchain = require('./blockchain');
// const secrets = require('./secrets');
// const codes = secrets.codes;

const FEW = 3;
const HUND = 50;
const MINUTE = 5;		// could change to 60
const NSHARDS = 2;		// could change to 3. simple is 2
const BITSRSA = 512;	// could change to 2048. simple is 512
const NODEMAP = {};		// key NODE, value NODECLASS
const SHARDMAP = [];	// index shard #, value arr of nodeclasses
var THEFED = null;		// see world.js. the one, global CentralBank

function log(x) { console.log(x); }

// input string or Buffer with hex encoding
// return sha256 hash
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

// return Buffer instead of hex string
function hashBuffer(data) { return crypto.createHash('sha256').update(data).digest(); }

// return ripemd160 hash
function hashAltBuffer(data) { return crypto.createHash('ripemd160').update(data).digest('hex'); }

// input string data and key. key often used as salt
// return sha256 hmac
function hmac(data, key) { return crypto.createHmac('sha256', key).update(data).digest('hex'); }

// input string data and private key pem
// return signature
function sign(data, privatePem) {
	const signer = crypto.createSign('RSA-SHA256');
	signer.update(data);
	return signer.sign(privatePem);
}

// input string data, public key pem, signature
// return true iff success
function verify(data, publicPem, signature) {
	const verifier = crypto.createVerify('RSA-SHA256');
	verifier.update(data);
	return verifier.verify(publicPem, signature);
}

// input public key pem
// return address as hex string
function publicPemToAddress(publicPem) {
	const publicKey = new NodeRSA();
	publicKey.importKey(publicPem, 'pkcs1-public');
	const N = publicKey.exportKey('components-public').n; // hex buffer

	const doublehash = hashAltBuffer(hashBuffer(N));
	const checksum = hash(hashBuffer(doublehash)).substr(0, 8);
	return doublehash + checksum;
}

// input private key from cryptico
// return key object with bigintegers converted to hex buffers
cryptico.skToHex = function(sk) {
	const keys = ['n', 'd', 'p', 'q', 'dmp1', 'dmq1', 'coeff'];
	const dict = {};
	keys.forEach(k => {
		// kludge prepend 0 if hex string has odd length
		if (k === 'coeff' && (sk[k].toString(16).length % 2) !== 0)
			dict[k] = Buffer.from('0'+sk[k].toString(16), 'hex');
		else
			dict[k] = Buffer.from(sk[k].toString(16), 'hex');
	});
	dict.e = 3;  // cryptico enforces exponent of 3
	return dict;
};

// input unique identifying string
// output shard number it falls in
function stringToShard(string) {
	const sample = 4;
	const decimal = parseInt(string.substr(0, sample), 16);
	return decimal % NSHARDS;
}

// simulate http request to instance
function messageNode(node, method, args) {
	const nodeClass = NODEMAP[node];	// NODE is string
	args.push(nodeClass);				// so has access to 'this'
	return nodeClass[method].apply(this, args);
}
function messageFed(method, args) {
	args.push(THEFED);
	return THEFED[method].apply(this, args);
}

// algorithm v.1
// input transaction TX, isCentralBankPrinting
// future replace isCentralBankPrinting with a signature of the CB. more secure
// BUNDLE is 2d object, BUNDLE[NODE][ADDRID.DIGEST] = VOTE
// return promise of whether tx is a success. logs queries and commits
function mainSendTx(tx, isCentralBankPrinting) {
	// phase 1 query
	const bundle = {};		// bundle of votes
	const queries = [];		// list of all query promises

	function notNullOrErr(x) { return x !== null && !(x instanceof Error); }

	// when central bank prints money, this loop skipped. no queries made
	for (var i in tx.inputs) {
		const addrid = tx.inputs[i];
		const nodes = SHARDMAP[addrid.shard];

		for (var ii in nodes) {
			const node = nodes[ii];
			// note: each query promise catches its own errors
			// note: so won't break Promise.all (neither will null promise)
			var query = messageNode(node, 'queryTx', [addrid, tx])
				.then(vote => {
					// log('vote is' + vote);
					log('query vote - node ' + node);
					if (!vote)
						return null;
					if (!bundle[node])					// if null, fill it
						bundle[node] = {};
					bundle[node][addrid.digest] = vote; // add vote

					return vote;
				}).catch(err => {
					log('query error ' + err);
					return err;
				});

			queries.push(query);
		}
	}

	// wait for all queries to finish
	// future add time limit on Promise.all throughout code
	// this still executes when central bank prints money (queries===[])
	return Promise.all(queries)
	.then(results => {
		// RESULTS is array of nulls, votes, or errors
		// log('queries results ' + results);

		if (!isCentralBankPrinting) {
			// local check that majority of votes are yes
			const yesses = results.filter(notNullOrErr).length;
			if (yesses <= results.length / 2) {
				log('queries rejected');
				return false;
			}

			log(`queries pass - ${yesses}/${results.length} - tx ${tx.digest.substr(0, 8)} - value ${tx.value}`);
		}

		// phase 2 commit
		const addridSample = tx.outputs[0];
		const nodes = SHARDMAP[addridSample.shard];
		const commits = []; // list of all commit promises

		for (var i in nodes) {
			const node = nodes[i];
			var commit = messageNode(node, 'commitTx', [tx, bundle, isCentralBankPrinting])
				.then(vote => {
					// log('vote is ' + vote);
					log('commit vote - node ' + node);
					return vote; // can be null
				}).catch(err => {
					log('commit error ' + err);
					return err;
				});

			commits.push(commit);
		}

		return Promise.all(commits)
		.then(results => {
			// RESULTS can be used as audit proof
			// RESULTS is array of nulls, votes, or errors
			// log('commits results ' + results + tx.value);

			// local check that majority of votes are yes
			const yesses = results.filter(notNullOrErr).length;
			if (yesses <= results.length / 2) {
				log('commits rejected');
				return false;
			}

			// reached success

			log(`commits pass - ${yesses}/${results.length} - tx ${tx.digest.substr(0, 8)} - value ${tx.value}`);

			return true;
		}).catch(err => {
			log('commits error ' + err);
			return false;
		});
	}).catch(err => {
		log('queries error ' + err);
		return false;
	});
}


class Vote {
	constructor(publicKey, signature) {
		this.pk = publicKey;
		this.sig = signature;
	}
}


class Addrid {
	constructor(tx, address, index, value) {
		this.txdigest = tx.digest;
		this.address = address;
		this.index = index; // index(address) in tx output
		this.value = value;
		this.digest = hash(tx.digest + address + index + value);
		this.shard = stringToShard(tx.digest); // function of tx
	}
}


class Tx {
	// note: first arg is addrids, second arg is addresses
	// but after instantiation, inputs and outputs are addrids
	constructor(inAddrids, outAddresses, value) {
		const inAddresses = [];
		if (inAddrids)
			inAddrids.forEach(ai => inAddresses.push(ai.address));

		// digest depends on addresses, not addrids
		this.digest = hash(inAddresses + outAddresses + value);

		const outAddrids = [];
		outAddresses.forEach((a, i) => outAddrids.push(new Addrid(this, a, i, value)));

		this.inputs = inAddrids;
		this.outputs = outAddrids;
		this.value = value;
	}
}


class Wallet {
	constructor(nickname, passphrase) {
		this.nickname = nickname; // nickname of user owner
		this.passphraseSafe = hmac(passphrase, nickname); // nickname like salt

		this.addressCount = 0;

		// AG abbreviates "address group"
		// arrays of {sk: val, pk: val, address: val, addrid: val}
		// future encrypt all the sks
		this.spareAGs = [];		// queue
		this.richAGs = [];		// queue
		this.usedAGs = [];		// list
	}

	// input N addresses to create, PASSPHRASE required
	// create new sks, pks, and addresses
	// return true iff success
	createAddresses(n, passphrase) {
		if (hmac(passphrase, this.nickname) !== this.passphraseSafe) {
			log('invalid passphrase');
			return false;
		}

		for (var i = 0; i < n; i++) {
			// deterministic private key, using uppercase nickname as key
			const seed = hmac(this.nickname + passphrase + this.addressCount, this.nickname.toUpperCase());
			const skDraft = cryptico.generateRSAKey(seed, BITSRSA);

			// private/secret key
			const sk = new NodeRSA();
			// note: adds leading zeros to n,p,q,dmp1 during import
			sk.importKey(cryptico.skToHex(skDraft), 'components');
			// log(sk.exportKey('components-private'))

			const privatePem = sk.exportKey('pkcs1-private');
			const publicPem = sk.exportKey('pkcs1-public');
			const publicAddress = publicPemToAddress(publicPem);

			this.spareAGs.push({
				sk: privatePem,
				pk: publicPem,
				address: publicAddress,
				addrid: null
			});

			this.addressCount += 1;
		}
		return true;
	}

	// if running low on spare addresses, create some
	// return oldest spare address group
	getSpareAG(passphrase) {
		if (hmac(passphrase, this.nickname) !== this.passphraseSafe) {
			log('invalid passphrase');
			return false;
		}

		if (this.spareAGs.length < FEW)
			this.createAddresses(FEW*FEW, passphrase);

		return this.spareAGs.shift();
	}

	// return oldest rich address group
	// future accept value argument, returns as many richAGs as necessary
	getRichAG(passphrase) {
		if (hmac(passphrase, this.nickname) !== this.passphraseSafe) {
			log('invalid passphrase');
			return false;
		}

		if (this.richAGs.length === 0) // no funds
			return null;

		return this.richAGs.shift();
	}

	// add successful tx array of ADDRESSGROUPS to RICHADDRESSGROUP
	// each ADDRESSGROUP now has non-null addrid field
	addRichAGs(addressGroups, passphrase) {
		if (hmac(passphrase, this.nickname) !== this.passphraseSafe) {
			log('invalid passphrase');
			return false;
		}

		Array.prototype.push.apply(this.richAGs, addressGroups);
		return true;
	}

	// add successful tx array of ADDRESSGROUPS to USEDADDRESSGROUP
	addUsedAGs(addressGroups, passphrase) {
		if (hmac(passphrase, this.nickname) !== this.passphraseSafe) {
			log('invalid passphrase');
			return false;
		}

		Array.prototype.push.apply(this.usedAGs, addressGroups);
		return true;
	}
}


class User {
	constructor(nickname, passphrase) {
		this.nickname = nickname;
		this.wallet = new Wallet(nickname, passphrase);
		this.wallet.createAddresses(HUND, passphrase);
	}

	// returns promise of success
	sendTx(tx) { return mainSendTx(tx, false); }
}


// NODECLASS is the class verifying txs, is the commercial bank
// NODECLASS.NICKNAME is what users understand as NODE
class NodeClass {
	constructor(nickname, passphrase) {
		this.nickname = nickname;	// must be unique. bank stock symbol?
		this.txset = [];			// array of unique sealed txs
		this.txsetDigests = {};		// key is TX.DIGEST, val true==in TXSET
		this.utxo = {};				// object of unspent tx outputs
									// key is ADDRID.DIGEST, val true==unspent
		this.pset = {};				// object of txs to catch double spending
									// key is ADDRID.DIGEST, val is tx

		this.updateGlobalNodeMap();
		this.shard = stringToShard(hash(nickname));
		this.updateGlobalShardMap();

		// future update sks and pks every period
		const privateKey = new NodeRSA({b: BITSRSA}); // for signing and verifs
		this.sk = privateKey.exportKey('pkcs1-private');
		this.pk = privateKey.exportKey('pkcs1-public');

		this.wallet = new Wallet(nickname, passphrase); // to receive fed fees
		this.wallet.createAddresses(FEW, passphrase);

		this.blockchain = new blockchain.Blockchain(); // init blockchain

		this.applyForFedAuth();

		this.jEpoch = 1;				// epoch number
		this.jPeriod = null;			// period number. set by central bank
		this.periodOpen = false;		// set by cb
		this.highlevelBlockHash = null;	// set by cb
	}

	// future. implement. and check for iscentralbankprinting bc tx.inputs null
	static checkTx(tx) {
		return true;
		var inVal = 0, outVal = 0;
		tx.inputs.forEach(ai => inVal += ai.value);
		tx.outputs.forEach(ai => outVal += ai.value);
		// 1 total input >= total output
		// 2 check input addrids point to valid txs
		// 3 check sigs authorizing prev tx outputs are valid
			// basically that the tx is signed?
			// does this mean we need sigs on every tx?
	}

	updateGlobalShardMap() {
		if (!SHARDMAP[this.shard])
			SHARDMAP[this.shard] = [];
		SHARDMAP[this.shard].push(this.nickname);
	}

	updateGlobalNodeMap() { NODEMAP[this.nickname] = this; }

	// apply to fed for authorization and send genesis block
	applyForFedAuth() {
		messageFed('handleNodeAuth', [this.nickname, this.pk]);
		messageFed('tempNodeSendGenBlock', [this.nickname, this.blockchain.getLatestBlock()]);
	}

	// future need to validate this is signed by cb
	setPeriod(period, self) {
		self.jPeriod = period;
	}
	setPeriodOpen(status, self) {
		self.periodOpen = status;
	}
	setHighlevelBlockHash(hash, self) {
		self.highlevelBlockHash = hash;
	}

	// algorithm v.2
	// input ADDRID, transaction TX
	// return promise of node's vote
	// when central banks prints money, won't get called
	queryTx(addrid, tx, self) {
		return new Promise((resolve, reject) => {
			const digest = addrid.digest;

			if (!NodeClass.checkTx(tx) || self.shard !== addrid.shard) {
				resolve(null);
			} else if (self.utxo[digest] || self.pset[digest].digest === tx.digest) {
				self.utxo[digest] = null;	// idempotent action
				self.pset[digest] = tx;		// idempotent action
				resolve(new Vote(self.pk, sign(tx.digest, self.sk)));
			} else {
				resolve(null);
			}
		});
	}

	// algorithm v.3
	// input transaction TX, BUNDLE, bool ISCENTRALBANKPRINTING
	// return promise of node's vote
	commitTx(tx, bundle, isCentralBankPrinting, self) {
		return new Promise((resolve, reject) => {
			const addridSample = tx.outputs[0];

			// future pass ISCENTRALBANKPRINTING into checkTx
			if (!NodeClass.checkTx(tx) || self.shard !== addridSample.shard) {
				resolve(null);
				return;
			}

			var allInputsValid = true;
			// if ISCENTRALBANKPRINTING loop will be skipped
			for (var i in tx.inputs) {
				const addrid = tx.inputs[i];
				const nodes = SHARDMAP[addrid.shard];
				var yesses = 0;

				for (var ii in nodes) {
					const node = nodes[ii];
					if (bundle[node] && bundle[node][addrid.digest]) {
						const vote = bundle[node][addrid.digest];
						// future line 9 algo 3
						// use authorizedNodes
							// if self.pk is in authorizednodes.map(arr=>arr[0]) // this should be saved for speed
						// if good to go
						// yesses += 1
					}
				}

				// if (yesses <= nodes.length / 2) {
				// 	log('queries invalid, commit rejected');
				// 	allInputsValid = false;
				// 	break;
				// }
			}

			if (!allInputsValid) {
				resolve(null);
				return;
			}

			for (var ii in tx.outputs) {
				const addrid = tx.outputs[ii];
				self.utxo[addrid.digest] = true;
			}

			if (self.txsetDigests[tx.digest] !== true) {
				self.txset.push(tx);
				self.txsetDigests[tx.digest] = true;
			}

			// resolve is not a return. code continues
			resolve(new Vote(self.pk, sign(tx.digest, self.sk)));

			// future use mset
			// issue lowlevel block only if enough txs and period is open
			if (self.txset.length < HUND/2 || !self.periodOpen)
				return;

			// now creating lowlevel block

			const txsetBuffs = self.txset.map(tx => Buffer.from(tx.digest, 'hex'));
			const txMerkle = fastRoot(txsetBuffs, hashBuffer).toString('hex');
			const node = self.nickname;

			const dataH = hash(
				self.highlevelBlockHash +
				self.blockchain.getLatestBlock().hash + // note: block's hash
				'future mset' +
				txMerkle);
			const sig = sign(dataH, self.sk);
			const data = [dataH, self.txset, sig, 'future mset', node];

			const nextBlock = self.blockchain.makeNextBlock(data);
			self.blockchain.addBlock(nextBlock);
			messageFed('addLowlevelBlock', [nextBlock]);

			const time = self.jPeriod + '.' + self.jEpoch;
			log('---------- ' + node + ' issued block ' + time);
			self.blockchain.writeToFile('bc-' + node + '-' + time + '.txt');

			self.jEpoch += 1;

			// future need to reset mset, pset
			self.txset = [];
			self.txsetDigests = {};
		});
	}
}


class CentralBank {
	constructor(nickname, passphrase) {
		this.nickname = nickname;
		this.txset = [];
		this.txsetDigests = {};

		this.setGlobalFed();

		const privateKey = new NodeRSA({b: BITSRSA});
		this.sk = privateKey.exportKey('pkcs1-private');
		this.pk = privateKey.exportKey('pkcs1-public');

		this.wallet = new Wallet(nickname, passphrase); // to pay nodes/users
		this.wallet.createAddresses(FEW, passphrase);

		this.authorizedNodes = [];
		this.authorizedNodesLastBlock = {}; // key NODE, value BLOCK

		this.blockchain = new blockchain.Blockchain();

		this.jPeriod = 1; // period number

		this.lowlevelQueue = []; // queue of lowlevel blocks pushed by nodes
		this.lowlevelQueueValidated = [];
	}

	setGlobalFed() { THEFED = this; }

	// handle nodeclass application for authorization
	handleNodeAuth(nickname, pk, self) {
		self.authorizedNodes.push({
			nickname: nickname,
			pk: pk,
			sig: sign(pk, self.sk)
		});
	}

	// todo remove
	tempNodeSendGenBlock(node, block, self) {
		if (!self.authorizedNodesLastBlock[node])
			self.authorizedNodesLastBlock[node] = block;
	}

	startProcessLoop() {
		// todo
		log('shards ' + JSON.stringify(SHARDMAP));
		log('nodemap' + JSON.stringify(NODEMAP).substr(0, 50));
		log(this.authorizedNodes);
		log(JSON.stringify(this.authorizedNodesLastBlock).substr(0, 50));
		this.authorizedNodes.forEach(an => {
			NODEMAP[an.nickname].blockchain.writeToFile('bc-' + an.nickname + '.txt');
		});


		// future remove block issue here, and have it done in processLLB
		const firstTxMerkle = hash('');
		const dataH = hash(
		    this.blockchain.getLatestBlock().hash + // note: block's hash
		    firstTxMerkle);
		const sig = sign(dataH, this.sk);
		const data = [dataH, [], sig, this.authorizedNodes];
		const nextBlock = this.blockchain.makeNextBlock(data);
		this.blockchain.addBlock(nextBlock);
		log('========== fed issued block ' + this.jPeriod);
		this.blockchain.writeToFile('bc-FED-' + this.jPeriod + '.txt');
		this.jPeriod += 1;
		// broadcast to all nodes
		// future should send with signature
		this.authorizedNodes.forEach(dto => {
		    messageNode(dto.nickname, 'setPeriod', [this.jPeriod]);
		    messageNode(dto.nickname, 'setPeriodOpen', [true]);
		    messageNode(dto.nickname, 'setHighlevelBlockHash',
		        [this.blockchain.getLatestBlock().hash]);
		});

		this.processLowlevelBlocks(0);
	}

	// returns promise of success
	sendTx(tx) { return mainSendTx(tx, false); }

	// central bank pays itself
	// return promise of whether printMoney a success
	printMoney(value, passphrase) {
		const ag = this.wallet.getSpareAG(passphrase);
		const tx = new Tx(null, [ag.address], value);
		// future save this tx in highlevel block
		return mainSendTx(tx, true)
		.then(success => {
			ag.addrid = tx.outputs[0];
			this.wallet.addRichAGs([ag], passphrase);
			return success;
		});
	}

	addLowlevelBlock(block, self) {
		self.lowlevelQueue.push(block);
	}

	// todo
	// validates blocks and adds their txs to cb's txs
	// returns promise after all blocks validated
	validateLowlevelBlocks(blocks) {
		return new Promise((resolve, reject) => {
			for (var i = 0; i < blocks.length; i += 1) {
				const block = blocks[i];
				const dataH = block.data[0],
					  txset = block.data[1],
					  sig = block.data[2],
					  node = block.data[4];
				const lastBlock = this.authorizedNodesLastBlock[node];

				const nodeDto = this.authorizedNodes.find((dto) => dto.nickname === node);

				if (!nodeDto || !verify(dataH, nodeDto.pk, sig)) {
					resolve(null);
					return;
				}

				const txsetBuffs = txset.map(tx => Buffer.from(tx.digest, 'hex'));
				const txMerkle = fastRoot(txsetBuffs, hashBuffer).toString('hex');
				const calcH = hash(
					this.blockchain.getLatestBlock().hash +
					lastBlock.hash +
					'future mset' +
					txMerkle);

				if (dataH !== calcH) {
					resolve(null);
					return;
				}

				if (!blockchain.Blockchain.isValidNewBlock(block, lastBlock)) {
					resolve(null);
					return;
				}

				// todo update value of cb's copy of node's prev lowlevel hash

				// todo if all good, add lowlevel txset to highlevel txset without duplicates

				// todo figure out whether lowlevelQueueValidated is needed if all txs are in the txset

				// assert all tests passed
				this.lowlevelQueueValidated.push(block);
			}

			resolve('done');

		});
	}

	// called on central bank init, then every second
	processLowlevelBlocks(index) {
		// thread safe, for if new lowlevel blocks are added during this fx
		const len = this.lowlevelQueue.length;
		const blocks = [];
		for (var i = 0; i < len; i += 1)
			blocks.push(this.lowlevelQueue.shift());

		this.validateLowlevelBlocks(blocks)
		.then(result => {
			// period ends approx every minute
			if (index === MINUTE) {
				index = 0;

				// notify nodes period ended
				// read from lowlevelQueueValidated
				// detect double spending
					// count # of each tx received from lowlevel blocks
					// rmv those that didn't get committed by majority of owners
					// in other words, check that each tx was included in lowlevel blocks by majority of nodes mapped to each tx output address
				// finalize txset for the period
				// gen and seal high level block
				// flush lowlevelQueueValidated, or archive to file
				// notify nodes new period open
					// give them period, periodOpen, and highLevelBlockHash
					// and authorizedNodes (or broadcast the whole blockchain)


				this.txset = [];
				this.txsetDigests = {};
			}

			// repeat every second
			setTimeout(this.processLowlevelBlocks.bind(this, index+1), 1000);
		}).catch(err => {
			log('lowlevel blocks failed to validate');
			return err;
		});
	}
}


module.exports.Tx = Tx;
module.exports.User = User;
module.exports.NodeClass = NodeClass;
module.exports.CentralBank = CentralBank;

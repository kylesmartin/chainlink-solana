import * as anchor from "@project-serum/anchor";
import { ProgramError, BN } from "@project-serum/anchor";
import * as borsh from "borsh";
import {
  SYSVAR_RENT_PUBKEY,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  Token,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

import { randomBytes, createHash } from "crypto";
import * as secp256k1 from "secp256k1";
import { keccak256 } from "ethereum-cryptography/keccak";
import { Round as OCRRound, OCR2Feed } from "@chainlink-sol-fork/solana-sdk";

// generate a new keypair using `solana-keygen new -o id.json`

let ethereumAddress = (publicKey: Buffer) => {
  return keccak256(publicKey).slice(12);
};

const Scope = {
  Version: { version: {} },
  Decimals: { decimals: {} },
  Description: { description: {} },
  // RoundData: { roundData: { roundId } },
  LatestRoundData: { latestRoundData: {} },
  Aggregator: { aggregator: {} },
};

class Assignable {
  constructor(properties) {
    Object.keys(properties).map((key) => {
      this[key] = properties[key];
    });
  }
}
class Round extends Assignable {}

describe("ocr2", async () => {
  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const billingAccessController = Keypair.generate();
  const requesterAccessController = Keypair.generate();
  const store = Keypair.generate();
  const flaggingThreshold = 80000;

  const observationPayment = 1;
  const transmissionPayment = 1;

  const state = Keypair.generate();
  // const stateSize = 8 + ;
  const feed = Keypair.generate();
  const payer = Keypair.generate();
  // const owner = Keypair.generate();
  const owner = provider.wallet;
  const mintAuthority = Keypair.generate();

  const placeholder = Keypair.generate().publicKey;

  const decimals = 18;
  const description = "ETH/BTC";

  const minAnswer = 1;
  const maxAnswer = 1000;
  const rounds = 15; // number of rounds submitted

  const workspace = anchor.workspace;
  const program = anchor.workspace.Ocr2;
  const accessController = anchor.workspace.AccessController;

  let token: Token, tokenClient: Token;
  let storeAuthority: PublicKey, storeNonce: number;
  let tokenVault: PublicKey, vaultAuthority: PublicKey, vaultNonce: number;

  let oracles = [];
  const f = 6;
  // NOTE: 17 is the most we can fit into one proposeConfig if we use a different payer
  // if the owner == payer then we can fit 19
  const n = 19; // min: 3 * f + 1;

  let query = async (
    feed: PublicKey,
    scope: any,
    schema: borsh.Schema,
    classType: any
  ): Promise<any> => {
    let tx = await workspace.Store.rpc.query(scope, {
      accounts: { feed },
      options: { commitment: "confirmed" },
    });
    // await provider.connection.confirmTransaction(tx);
    let t = await provider.connection.getConfirmedTransaction(tx, "confirmed");

    // "Program return: <key> <val>"
    const prefix = "Program return: ";
    let log = t.meta.logMessages.find((log) => log.startsWith(prefix));
    log = log.slice(prefix.length);
    let [_key, data] = log.split(" ", 2);
    // TODO: validate key
    let buf = Buffer.from(data, "base64");
    console.log(buf);

    return borsh.deserialize(schema, classType, buf);
  };

  // transmits a single round
  let transmit = async (
    epoch: number,
    round: number,
    answer: BN,
    juels: Buffer = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]), // juels per lamport (2)
  ): Promise<string> => {
    let account = await program.account.state.fetch(state.publicKey);

    // Generate and transmit a report
    let report_context = Buffer.alloc(96);
    report_context.set(account.config.latestConfigDigest, 0); // 32 byte config digest
    // 27 byte padding
    report_context.writeUInt32BE(epoch, 32 + 27); // 4 byte epoch
    report_context.writeUInt8(round, 32 + 27 + 4); // 1 byte round
    // 32 byte extra_hash

    const raw_report = Buffer.concat([
      Buffer.from([
        97,
        91,
        43,
        83, // observations_timestamp
        7, // observer_count
        0,
        1,
        2,
        3,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0, // observers
      ]),
      Buffer.from(answer.toArray("be", 16)), // median (i128)
      juels,
    ]);

    let hash = createHash("sha256")
      .update(Buffer.from([raw_report.length]))
      .update(raw_report)
      .update(report_context)
      .digest();

    let raw_signatures = [];
    for (let oracle of oracles.slice(0, f + 1)) {
      // sign with `f` + 1 oracles
      let { signature, recid } = secp256k1.ecdsaSign(
        hash,
        oracle.signer.secretKey
      );
      raw_signatures.push(...signature);
      raw_signatures.push(recid);
    }

    const transmitter = oracles[0].transmitter;

    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        programId: anchor.translateAddress(program.programId),
        keys: [
          { pubkey: state.publicKey, isWritable: true, isSigner: false },
          { pubkey: transmitter.publicKey, isWritable: false, isSigner: true },
          {
            pubkey: feed.publicKey,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: workspace.Store.programId,
            isWritable: false,
            isSigner: false,
          },
          { pubkey: storeAuthority, isWritable: false, isSigner: false },
        ],
        data: Buffer.concat([
          Buffer.from([storeNonce]),
          report_context,
          raw_report,
          Buffer.from(raw_signatures),
        ]),
      })
    );

    try {
      return await provider.send(tx, [transmitter]);
    } catch (err) {
      // Translate IDL error
      const idlErrors = anchor.parseIdlErrors(program.idl);
      let translatedErr = ProgramError.parse(err, idlErrors);
      if (translatedErr === null) {
        throw err;
      }
      throw translatedErr;
    }
  };

  it("Funds the payer", async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 10000000000),
      "confirmed"
    );
  });

  it("Creates the LINK token", async () => {
    token = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      9, // SPL tokens use a u64, we can fit enough total supply in 9 decimals. Smallest unit is Gjuels
      TOKEN_PROGRAM_ID
    );

    tokenClient = new Token(
      provider.connection,
      token.publicKey,
      TOKEN_PROGRAM_ID,
      // @ts-ignore
      program.provider.wallet.payer
    );
  });

  it("Creates access controllers", async () => {
    await accessController.rpc.initialize({
      accounts: {
        state: billingAccessController.publicKey,
        owner: owner.publicKey,
      },
      signers: [billingAccessController],
      preInstructions: [
        await accessController.account.accessController.createInstruction(
          billingAccessController
        ),
      ],
    });
    await accessController.rpc.initialize({
      accounts: {
        state: requesterAccessController.publicKey,
        owner: owner.publicKey,
      },
      signers: [requesterAccessController],
      preInstructions: [
        await accessController.account.accessController.createInstruction(
          requesterAccessController
        ),
      ],
    });
  });

  it("Creates a store", async () => {
    await workspace.Store.rpc.initialize({
      accounts: {
        store: store.publicKey,
        owner: owner.publicKey,
        loweringAccessController: billingAccessController.publicKey,
      },
      signers: [store],
      preInstructions: [
        await workspace.Store.account.store.createInstruction(store),
      ],
    });
  });

  it("Creates the token vault", async () => {
    [vaultAuthority, vaultNonce] = await PublicKey.findProgramAddress(
      [
        Buffer.from(anchor.utils.bytes.utf8.encode("vault")),
        state.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Create an associated token account for LINK, owned by the program instance
    tokenVault = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.publicKey,
      vaultAuthority,
      true // allowOwnerOffCurve: seems required since a PDA isn't a valid keypair
    );
  });

  it("Initializes the OCR2 feed", async () => {
    console.log("Initializing...");

    console.log("state", state.publicKey.toBase58());
    console.log("feed", feed.publicKey.toBase58());
    console.log("payer", provider.wallet.publicKey.toBase58());
    console.log("owner", owner.publicKey.toBase58());
    console.log("tokenMint", token.publicKey.toBase58());
    console.log("tokenVault", tokenVault.toBase58());
    console.log("vaultAuthority", vaultAuthority.toBase58());
    console.log("placeholder", placeholder.toBase58());

    const granularity = 30;
    const liveLength = 3;
    await workspace.Store.rpc.createFeed(
      description,
      decimals,
      granularity,
      liveLength,
      {
        accounts: {
          feed: feed.publicKey,
          authority: owner.publicKey,
        },
        signers: [feed],
        preInstructions: [
          await workspace.Store.account.transmissions.createInstruction(
            feed,
            8 + 192 + 6 * 48
          ),
        ],
      }
    );
    // Program log: panicked at 'range end index 8 out of range for slice of length 0', store/src/lib.rs:476:10

    // Configure threshold for the feed
    await workspace.Store.rpc.setValidatorConfig(flaggingThreshold, {
      accounts: {
        feed: feed.publicKey,
        owner: owner.publicKey,
        authority: owner.publicKey,
      },
      signers: [],
    });

    // store authority for our ocr2 config
    [storeAuthority, storeNonce] = await PublicKey.findProgramAddress(
      [
        Buffer.from(anchor.utils.bytes.utf8.encode("store")),
        state.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  // it("Migrates the feed", async () => {
  //   let transmissionAccounts = [
  //     {
  //       pubkey: feed.publicKey,
  //       isSigner: false,
  //       isWritable: true,
  //     },
  //   ];
  //   const migrateData = workspace.Store.coder.instruction.encode("migrate", {});
  //   const migrateAccounts = [
  //     {
  //       pubkey: store.publicKey,
  //       isSigner: false,
  //       isWritable: true,
  //     },
  //     {
  //       pubkey: owner.publicKey,
  //       isSigner: true,
  //       isWritable: false,
  //     },
  //     ...transmissionAccounts,
  //   ];
  //   const tx = new Transaction();
  //   tx.add(
  //     new TransactionInstruction({
  //       data: migrateData,
  //       keys: migrateAccounts,
  //       programId: workspace.Store.programId,
  //     })
  //   );

  //   try {
  //     await provider.send(tx, []);
  //   } catch (err) {
  //     // Translate IDL error
  //     const idlErrors = anchor.parseIdlErrors(program.idl);
  //     let translatedErr = ProgramError.parse(err, idlErrors);
  //     if (translatedErr === null) {
  //       throw err;
  //     }
  //     throw translatedErr;
  //   }
  // });

  it("Initializes the OCR2 config", async () => {
    await program.rpc.initialize(
      new BN(minAnswer),
      new BN(maxAnswer),
      {
        accounts: {
          state: state.publicKey,
          feed: feed.publicKey,
          payer: provider.wallet.publicKey,
          owner: owner.publicKey,
          tokenMint: token.publicKey,
          tokenVault: tokenVault,
          vaultAuthority: vaultAuthority,
          requesterAccessController: requesterAccessController.publicKey,
          billingAccessController: billingAccessController.publicKey,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        },
        signers: [state],
        preInstructions: [
          await program.account.state.createInstruction(state),
          // await store.account.transmissions.createInstruction(transmissions, 8+192+8096*24),
          // createFeed,
        ],
      }
    );

    let account = await program.account.state.fetch(state.publicKey);
    let config = account.config;
    assert.ok(config.minAnswer.toNumber() == minAnswer);
    assert.ok(config.maxAnswer.toNumber() == maxAnswer);
    // assert.ok(config.decimals == 18);

    console.log(`Generating ${n} oracles...`);
    let futures = [];
    let generateOracle = async () => {
      let secretKey = randomBytes(32);
      let transmitter = Keypair.generate();
      return {
        signer: {
          secretKey,
          publicKey: secp256k1.publicKeyCreate(secretKey, false).slice(1), // compressed = false, skip first byte (0x04)
        },
        transmitter,
        // Initialize a token account
        payee: await token.getOrCreateAssociatedAccountInfo(
          transmitter.publicKey
        ),
      };
    };
    for (let i = 0; i < n; i++) {
      futures.push(generateOracle());
    }
    oracles = await Promise.all(futures);

    const offchain_config_version = 2;
    const offchain_config = Buffer.from([4, 5, 6]);

    // Fund the owner with LINK tokens
    await token.mintTo(
      tokenVault,
      mintAuthority.publicKey,
      [mintAuthority],
      100000000000000
    );

    // TODO: listen for SetConfig event
    let proposal = Keypair.generate();

    console.log("createProposal");
    await program.rpc.createProposal(new BN(offchain_config_version), {
      accounts: {
        proposal: proposal.publicKey,
        authority: owner.publicKey,
      },
      signers: [proposal],
      preInstructions: [
        await program.account.proposal.createInstruction(proposal),
      ],
    });
    console.log("proposeConfig");
    await program.rpc.proposeConfig(
      oracles.map((oracle) => ({
        signer: ethereumAddress(Buffer.from(oracle.signer.publicKey)),
        transmitter: oracle.transmitter.publicKey,
      })),
      f,
      {
        accounts: {
          proposal: proposal.publicKey,
          authority: owner.publicKey,
        },
        signers: [],
      }
    );
    console.log("writeOffchainConfig");
    await program.rpc.writeOffchainConfig(offchain_config, {
      accounts: {
        proposal: proposal.publicKey,
        authority: owner.publicKey,
      },
    });
    console.log("writeOffchainConfig");
    await program.rpc.writeOffchainConfig(offchain_config, {
      accounts: {
        proposal: proposal.publicKey,
        authority: owner.publicKey,
      },
    });

    console.log("proposePayees");
    await program.rpc.proposePayees(
      token.publicKey,
      oracles.map((oracle) => oracle.payee.address),
      {
        accounts: {
          proposal: proposal.publicKey,
          authority: owner.publicKey,
        },
      }
    );

    console.log("finalizeProposal");
    await program.rpc.finalizeProposal({
      accounts: {
        proposal: proposal.publicKey,
        authority: owner.publicKey,
      },
    });

    // compute proposal digest
    let proposalAccount = await program.account.proposal.fetch(proposal.publicKey);
    console.log(proposalAccount);

    let proposalOracles = proposalAccount.oracles.xs.slice(0, proposalAccount.oracles.len);
    let proposalOC = proposalAccount.offchainConfig.xs.slice(0, proposalAccount.offchainConfig.len);

    let hasher = createHash("sha256").update(Buffer.from([proposalAccount.oracles.len]));
    hasher = proposalOracles.reduce((hasher, oracle) => {
      return hasher
        .update(Buffer.from(oracle.signer.key))
        .update(oracle.transmitter.toBuffer())
        .update(oracle.payee.toBuffer())
    }, hasher);

    let offchainConfigHeader = Buffer.alloc(8+4);
    offchainConfigHeader.writeBigUInt64BE(BigInt(proposalAccount.offchainConfig.version), 0);
    offchainConfigHeader.writeUInt32BE(proposalAccount.offchainConfig.len, 8);

    let digest = hasher
      .update(Buffer.from([f]))
      .update(proposalAccount.tokenMint.toBuffer())
      .update(offchainConfigHeader)
      .update(Buffer.from(proposalOC))
      .digest();

    // fetch payees
    account = await program.account.state.fetch(state.publicKey);
    let currentOracles = account.oracles.xs.slice(0, account.oracles.len);
    let payees = currentOracles.map((oracle) => {
      return { pubkey: oracle.payee, isWritable: true, isSigner: false };
    });

    console.log("approveProposal");
    await program.rpc.acceptProposal(digest, {
      accounts: {
        state: state.publicKey,
        proposal: proposal.publicKey,
        receiver: owner.publicKey,
        authority: owner.publicKey,
        tokenVault: tokenVault,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: payees,
    });

    // TODO: validate that payees were paid

    account = await program.account.state.fetch(state.publicKey);
    assert.ok(account.offchainConfig.len == 6);
    assert.deepEqual(
      account.offchainConfig.xs.slice(0, account.offchainConfig.len),
      [4, 5, 6, 4, 5, 6]
    );

    // Proposal already closed by acceptProposal
    // console.log("closeProposal");
    // await program.rpc.closeProposal(
    //   {
    //     accounts: {
    //       proposal: proposal.publicKey,
    //       authority: owner.publicKey,
    //       receiver: owner.publicKey,
    //     },
    // });

    // TODO: assert funds came back

    // fetch payees
    account = await program.account.state.fetch(state.publicKey);
    currentOracles = account.oracles.xs.slice(0, account.oracles.len);
    payees = currentOracles.map((oracle) => {
      return { pubkey: oracle.payee, isWritable: true, isSigner: false };
    });

    console.log("setBilling");
    await program.rpc.setBilling(
      new BN(observationPayment),
      new BN(transmissionPayment),
      {
        accounts: {
          state: state.publicKey,
          authority: owner.publicKey,
          accessController: billingAccessController.publicKey,
          tokenVault: tokenVault,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [],
        remainingAccounts: payees,
      }
    );

    // log raw state account data
    // let rawAccount = await provider.connection.getAccountInfo(state.publicKey);
    // console.dir([...rawAccount.data], { maxArrayLength: null });
  });

  let proposal = Keypair.generate();

  it("Can't begin config proposal if version is 0", async () => {
    try {
      await program.rpc.createProposal(new BN(0), {
        accounts: {
          proposal: proposal.publicKey,
          authority: owner.publicKey,
        },
      });
    } catch {
      // createOffchainConfig should fail
      return;
    }
    assert.fail("createProposal shouldn't have succeeded!");
  });

  it("Can't write offchain config if begin has not been called", async () => {
    let proposal = Keypair.generate();
    try {
      await program.rpc.writeOffchainConfig(Buffer.from([4, 5, 6]), {
        accounts: {
          proposal: proposal.publicKey,
          authority: owner.publicKey,
        },
      });
    } catch {
      // writeOffchainConfig should fail
      return;
    }
    assert.fail("writeOffchainConfig shouldn't have succeeded!");
  });

  // it("ResetPendingOffchainConfig clears pending state", async () => {

  // 	await program.rpc.createProposal(
  //      new BN(2),
  //      {
  //        accounts: {
  //          state: state.publicKey,
  //          authority: owner.publicKey,
  //        },
  //    });
  //    await program.rpc.writeOffchainConfig(
  //      Buffer.from([4, 5, 6]),
  //      {
  //        accounts: {
  //          state: state.publicKey,
  //          authority: owner.publicKey,
  //        },
  //    });
  // 	let account = await program.account.state.fetch(state.publicKey);
  // 	assert.ok(account.pendingOffchainConfig.version != 0);
  // 	assert.ok(account.pendingOffchainConfig.len != 0);
  // 	await program.rpc.resetPendingOffchainConfig(
  // 		{
  // 			accounts: {
  // 				state: state.publicKey,
  // 				authority: owner.publicKey,
  // 			},
  // 	});
  // 	account = await program.account.state.fetch(state.publicKey);
  // 	assert.ok(account.pendingOffchainConfig.version == 0);
  // 	assert.ok(account.pendingOffchainConfig.len == 0);
  // })

  // it("Can't reset pending config if already in new state", async () => {
  // 	try {
  // 		await program.rpc.resetPendingOffchainConfig(
  // 			{
  // 				accounts: {
  // 					state: state.publicKey,
  // 					authority: owner.publicKey,
  // 				},
  // 		});
  // 	} catch {
  // 		// resetPendingOffchainConfig should fail
  // 		return
  // 	}
  // 	assert.fail("resetPendingOffchainConfig shouldn't have succeeded!")
  // });

  it("Can't transmit a round if not the writer", async () => {
    try {
      await transmit(1, 1, new BN(1));
    } catch {
      // transmit should fail
      return;
    }
    assert.fail("transmit() shouldn't have succeeded!");
  });

  it("Sets the cluster as the feed writer", async () => {
    await workspace.Store.rpc.setWriter(storeAuthority, {
      accounts: {
        feed: feed.publicKey,
        owner: owner.publicKey,
        authority: owner.publicKey,
      },
    });
  });

  it("Transfers ownership to the store", async () => {
    // transfer to the store
    await workspace.Store.rpc.transferFeedOwnership(store.publicKey, {
      accounts: {
        feed: feed.publicKey,
        owner: owner.publicKey,
        authority: owner.publicKey,
      },
    });

    // accept (authority = store.owner)
    await workspace.Store.rpc.acceptFeedOwnership({
      accounts: {
        feed: feed.publicKey,
        proposedOwner: store.publicKey,
        authority: owner.publicKey,
      },
    });
  });

  it("Transmits a round", async () => {
    await transmit(1, 2, new BN(3));
  });

  it("Withdraws funds", async () => {
    const recipient = await token.createAccount(placeholder);
    let recipientTokenAccount = await token.getOrCreateAssociatedAccountInfo(
      recipient
    );

    await program.rpc.withdrawFunds(new BN(1), {
      accounts: {
        state: state.publicKey,
        authority: owner.publicKey,
        accessController: billingAccessController.publicKey,
        tokenVault: tokenVault,
        vaultAuthority: vaultAuthority,
        recipient: recipientTokenAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [],
    });

    recipientTokenAccount = await tokenClient.getOrCreateAssociatedAccountInfo(
      recipient
    );
    assert.ok(recipientTokenAccount.amount.toNumber() === 1);
  });

  const roundSchema = new Map([
    [
      Round,
      {
        kind: "struct",
        fields: [
          ["roundId", "u32"],
          ["slot", "u64"],
          ["timestamp", "u32"],
          ["answer", [16]], // i128
        ],
      },
    ],
  ]);
  it("Can call query", async () => {
    let round = await query(
      feed.publicKey,
      Scope.LatestRoundData,
      roundSchema,
      Round
    );
    console.log(round);

    const versionSchema = new Map([
      [Round, { kind: "struct", fields: [["version", "u8"]] }],
    ]);
    let data = await query(
      feed.publicKey,
      Scope.Version,
      versionSchema,
      Round
    );
    assert.ok(data.version == 2);

    const descriptionSchema = new Map([
      [Round, { kind: "struct", fields: [["description", "string"]] }],
    ]);
    data = await query(
      feed.publicKey,
      Scope.Description,
      descriptionSchema,
      Round
    );
    assert.ok(data.description == "ETH/BTC");
  });

  it("Transmit a bunch of rounds to check ringbuffer wraparound", async () => {
    for (let i = 2; i <= rounds; i++) {
      let transmitTx = await transmit(i, i, new BN(i));

      await provider.connection.confirmTransaction(transmitTx);
      let t = await provider.connection.getTransaction(transmitTx, {
        commitment: "confirmed",
      });
      console.log(t.meta.logMessages);

      let round = await query(
        feed.publicKey,
        Scope.LatestRoundData,
        roundSchema,
        Round
      );
      assert.equal(new BN(round.answer, 10, "le").toNumber(), i);
    }
  });

  it ("Node payouts happen with the correct decimals", async () => {
    // fetch payees
    let account = await program.account.state.fetch(state.publicKey);
    let currentOracles = account.oracles.xs.slice(0, account.oracles.len);
    let transmitter: PublicKey;
    let payees = currentOracles.map((oracle) => {
      if (!oracle.paymentGjuels.isZero()) {
        // oracle payment calculated with:
        // + 2 juels per lamport => rounded to 0
        // + 1 gjuel
        // = 1 gjuel
        assert.equal(transmissionPayment*rounds, oracle.paymentGjuels.toNumber())
        transmitter = oracle.payee;
      }
      return { pubkey: oracle.payee, isWritable: true, isSigner: false };
    });

    await program.rpc.payOracles({
      accounts: {
        state: state.publicKey,
        authority: owner.publicKey,
        accessController: billingAccessController.publicKey,
        tokenVault: tokenVault,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: payees,
    });

    for (let i = 0; i < payees.length; i++) {
      const account = await tokenClient.getAccountInfo(payees[i].pubkey)
      if (payees[i].pubkey.equals(transmitter)) {
        // transmitter + observation payment
        assert.equal((observationPayment+transmissionPayment)*rounds, account.amount.toNumber())
        continue;
      }
      // observation payment
      assert.equal(observationPayment*rounds, account.amount.toNumber())
    }

  });

  it("Transmit does not fail on juelsPerFeecoin edge cases", async () => {
    // zero value u64 juelsPerFeecoin
    await transmit(rounds+1, rounds+1, new BN(rounds+1), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));

    // max value u64 juelsPerFeecoin
    await transmit(rounds+2, rounds+2, new BN(rounds+2), Buffer.from([127, 127, 127, 127, 127, 127, 127, 127]));
  })

  it("TS client listens and parses state", async () => {
    let feed = new OCR2Feed(program, provider);
    let listener = null;

    let success = new Promise<OCRRound>((resolve, _reject) => {
      listener = feed.onRound(state.publicKey, (event) => {
        resolve(event)
      });
    });

    let transmitTx = transmit(100, 1, new BN(16));
  
    let event = await success;
    assert.ok(event.feed.equals(state.publicKey))
    assert.equal(event.answer.toNumber(), 16)

    await feed.removeListener(listener);
  })

  it("Reclaims rent exempt deposit when closing down a feed", async () => {
    let beforeBalance = (
      await provider.connection.getAccountInfo(provider.wallet.publicKey)
    ).lamports;

    await workspace.Store.rpc.closeFeed({
      accounts: {
        feed: feed.publicKey,
        owner: store.publicKey,
        receiver: provider.wallet.publicKey,
        authority: owner.publicKey,
      },
    });

    let afterBalance = (
      await provider.connection.getAccountInfo(provider.wallet.publicKey)
    ).lamports;

    // Retrieved rent exemption sol.
    assert.ok(afterBalance > beforeBalance);

    const closedAccount = await provider.connection.getAccountInfo(
      feed.publicKey
    );
    assert.ok(closedAccount === null);
  });

  it("Reclaims rent exempt deposit when closing down an aggregator", async () => {
    let beforeBalance = (
      await provider.connection.getAccountInfo(provider.wallet.publicKey)
    ).lamports;

    // fetch payees
    let account = await program.account.state.fetch(state.publicKey);
    let currentOracles = account.oracles.xs.slice(0, account.oracles.len);
    let payees = currentOracles.map((oracle) => {
      return { pubkey: oracle.payee, isWritable: true, isSigner: false };
    });

    await program.rpc.close({
      accounts: {
        state: state.publicKey,
        receiver: provider.wallet.publicKey,
        authority: owner.publicKey,
        tokenVault: tokenVault,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: payees,
    });

    let afterBalance = (
      await provider.connection.getAccountInfo(provider.wallet.publicKey)
    ).lamports;

    // Retrieved rent exemption sol.
    assert.ok(afterBalance > beforeBalance);

    const closedAccount = await provider.connection.getAccountInfo(
      feed.publicKey
    );
    assert.ok(closedAccount === null);
  });

  it("Fails to create new feeds for invalid account sizes", async () => {
    const granularity = 30;
    const liveLength = 3;

    const header = 8 + 192 // account discriminator + header
    const transmissionSize = 48
    const invalidLengths = [
      header - 1, // insufficient for header size
      header + 6 * transmissionSize - 1, // incorrect size for ring buffer
      header + 2 * transmissionSize, // live length exceeds total capacity
    ]
    for (let i = 0; i < invalidLengths.length; i++) {
      try {
        const invalidFeed = Keypair.generate();
        await workspace.Store.rpc.createFeed(
          description,
          decimals,
          granularity,
          liveLength,
          {
            accounts: {
              feed: invalidFeed.publicKey,
              authority: owner.publicKey,
            },
            signers: [invalidFeed],
            preInstructions: [
              await workspace.Store.account.transmissions.createInstruction(
                invalidFeed,
                invalidLengths[i]
              ),
            ],
          }
        );
      } catch {
        continue; // expect error
      }
      assert.fail(`create feed shouldn't have succeeded with account size ${invalidLengths[i]}`);
    }
  });

});

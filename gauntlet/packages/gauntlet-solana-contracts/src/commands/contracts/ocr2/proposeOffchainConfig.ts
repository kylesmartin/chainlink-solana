import { Result } from '@chainlink/gauntlet-core'
import { logger, prompt, time, BN, longs } from '@chainlink/gauntlet-core/dist/utils'
import { SolanaCommand, TransactionResponse } from '@chainlink-sol-fork/gauntlet-solana'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { MAX_TRANSACTION_BYTES, ORACLES_MAX_LENGTH } from '../../../lib/constants'
import { CONTRACT_LIST, getContract } from '../../../lib/contracts'
import { divideIntoChunks } from '../../../lib/utils'
import { serializeOffchainConfig, deserializeConfig } from '../../../lib/encoding'
import RDD from '../../../lib/rdd'
import { printDiff } from '../../../lib/diff'

export type OffchainConfig = {
  deltaProgressNanoseconds: number
  deltaResendNanoseconds: number
  deltaRoundNanoseconds: number
  deltaGraceNanoseconds: number
  deltaStageNanoseconds: number
  rMax: number
  s: number[]
  offchainPublicKeys: string[]
  peerIds: string[]
  reportingPluginConfig: {
    alphaReportInfinite: boolean
    alphaReportPpb: number
    alphaAcceptInfinite: boolean
    alphaAcceptPpb: number
    deltaCNanoseconds: number
  }
  maxDurationQueryNanoseconds: number
  maxDurationObservationNanoseconds: number
  maxDurationReportNanoseconds: number
  maxDurationShouldAcceptFinalizedReportNanoseconds: number
  maxDurationShouldTransmitAcceptedReportNanoseconds: number
  configPublicKeys: string[]
}

type Input = {
  proposalId: string
  offchainConfig: OffchainConfig
  userSecret?: string
}

type ContractInput = {
  serializedOffchainConfig: Buffer
  randomSecret: string
}

export const prepareOffchainConfigForDiff = (config: OffchainConfig, extra?: Object): Object => {
  return longs.longsInObjToNumbers({
    ...config,
    ...(extra || {}),
    offchainPublicKeys: config.offchainPublicKeys?.map((key) => Buffer.from(key).toString('hex')),
  }) as Object
}

export default class ProposeOffchainConfig extends SolanaCommand {
  static id = 'ocr2:propose_offchain_config'
  static category = CONTRACT_LIST.OCR_2
  static examples = [
    'yarn gauntlet ocr2:propose_offchain_config --network=devnet --rdd=[PATH_TO_RDD] --proposalId=<PROPOSAL_ID> <AGGREGATOR_ADDRESS>',
  ]

  input: Input
  contractInput: ContractInput

  constructor(flags, args) {
    super(flags, args)

    this.require(
      !!this.flags.proposalId || !!this.flags.configProposal,
      'Please provide Config Proposal ID with flag "proposalId" or "configProposal"',
    )
    this.requireArgs('Please provide a valid aggregator address as arg')
    this.require(
      !!process.env.SECRET,
      'Please specify the Gauntlet secret words e.g. SECRET="awe fluke polygon tonic lilly acuity onyx debra bound gilbert wane"',
    )
  }

  static makeInputFromRDD = (rdd: any, stateAddress: string): OffchainConfig => {
    const aggregator = rdd.contracts[stateAddress]
    const config = aggregator.config

    const _toHex = (a: string) => Buffer.from(a, 'hex')
    const _getSigner = (o) => o.ocr2OnchainPublicKey[0].replace('ocr2on_solana_', '')
    const aggregatorOperators: any[] = aggregator.oracles
      .map((o) => rdd.operators[o.operator])
      .sort((a, b) => Buffer.compare(_toHex(_getSigner(a)), _toHex(_getSigner(b))))
    const operatorsPublicKeys = aggregatorOperators.map((o) =>
      o.ocr2OffchainPublicKey[0].replace('ocr2off_solana_', ''),
    )
    const operatorsPeerIds = aggregatorOperators.map((o) => o.peerId[0])
    const operatorConfigPublicKeys = aggregatorOperators.map((o) =>
      o.ocr2ConfigPublicKey[0].replace('ocr2cfg_solana_', ''),
    )

    const input: OffchainConfig = {
      deltaProgressNanoseconds: time.durationToNanoseconds(config.deltaProgress).toNumber(),
      deltaResendNanoseconds: time.durationToNanoseconds(config.deltaResend).toNumber(),
      deltaRoundNanoseconds: time.durationToNanoseconds(config.deltaRound).toNumber(),
      deltaGraceNanoseconds: time.durationToNanoseconds(config.deltaGrace).toNumber(),
      deltaStageNanoseconds: time.durationToNanoseconds(config.deltaStage).toNumber(),
      rMax: config.rMax,
      s: config.s,
      offchainPublicKeys: operatorsPublicKeys,
      peerIds: operatorsPeerIds,
      reportingPluginConfig: {
        alphaReportInfinite: config.reportingPluginConfig.alphaReportInfinite,
        alphaReportPpb: Number(config.reportingPluginConfig.alphaReportPpb),
        alphaAcceptInfinite: config.reportingPluginConfig.alphaAcceptInfinite,
        alphaAcceptPpb: Number(config.reportingPluginConfig.alphaAcceptPpb),
        deltaCNanoseconds: time.durationToNanoseconds(config.reportingPluginConfig.deltaC).toNumber(),
      },
      maxDurationQueryNanoseconds: time.durationToNanoseconds(config.maxDurationQuery).toNumber(),
      maxDurationObservationNanoseconds: time.durationToNanoseconds(config.maxDurationObservation).toNumber(),
      maxDurationReportNanoseconds: time.durationToNanoseconds(config.maxDurationReport).toNumber(),
      maxDurationShouldAcceptFinalizedReportNanoseconds: time
        .durationToNanoseconds(config.maxDurationShouldAcceptFinalizedReport)
        .toNumber(),
      maxDurationShouldTransmitAcceptedReportNanoseconds: time
        .durationToNanoseconds(config.maxDurationShouldTransmitAcceptedReport)
        .toNumber(),
      configPublicKeys: operatorConfigPublicKeys,
    }
    return input
  }

  makeInput = async (userInput: any): Promise<Input> => {
    if (userInput) return userInput as Input
    const rdd = RDD.load(this.flags.network, this.flags.rdd)

    const ocr2 = getContract(CONTRACT_LIST.OCR_2, '')
    const address = ocr2.programId.toString()
    this.program = this.loadProgram(ocr2.idl, address)

    const userSecret = this.flags.secret
    if (!!userSecret) {
      logger.info(`Using given random secret: ${userSecret}`)
    }

    const offchainConfig = ProposeOffchainConfig.makeInputFromRDD(rdd, this.args[0])

    return {
      offchainConfig,
      proposalId: this.flags.proposalId || this.flags.configProposal,
      userSecret,
    }
  }

  makeContractInput = async (input: Input): Promise<ContractInput> => {
    // process.env.SECRET is required on the command
    const { offchainConfig, userSecret } = input
    const { offchainConfig: serializedOffchainConfig, randomSecret } = await serializeOffchainConfig(
      offchainConfig,
      process.env.SECRET!,
      userSecret,
    )

    return {
      serializedOffchainConfig,
      randomSecret,
    }
  }

  validateConfig = (input: OffchainConfig): boolean => {
    const _isNegative = (v: number): boolean => new BN(v).lt(new BN(0))
    const nonNegativeValues = [
      'deltaProgressNanoseconds',
      'deltaResendNanoseconds',
      'deltaRoundNanoseconds',
      'deltaGraceNanoseconds',
      'deltaStageNanoseconds',
      'maxDurationQueryNanoseconds',
      'maxDurationObservationNanoseconds',
      'maxDurationReportNanoseconds',
      'maxDurationShouldAcceptFinalizedReportNanoseconds',
      'maxDurationShouldTransmitAcceptedReportNanoseconds',
    ]
    for (let prop in nonNegativeValues) {
      if (_isNegative(input[prop])) throw new Error(`${prop} must be non-negative`)
    }
    const safeIntervalNanoseconds = new BN(200).mul(time.Millisecond).toNumber()
    if (input.deltaProgressNanoseconds < safeIntervalNanoseconds)
      throw new Error(
        `deltaProgressNanoseconds (${input.deltaProgressNanoseconds} ns)  is set below the resource exhaustion safe interval (${safeIntervalNanoseconds} ns)`,
      )
    if (input.deltaResendNanoseconds < safeIntervalNanoseconds)
      throw new Error(
        `deltaResendNanoseconds (${input.deltaResendNanoseconds} ns) is set below the resource exhaustion safe interval (${safeIntervalNanoseconds} ns)`,
      )

    if (input.deltaRoundNanoseconds >= input.deltaProgressNanoseconds)
      throw new Error(
        `deltaRoundNanoseconds (${input.deltaRoundNanoseconds}) must be less than deltaProgressNanoseconds (${input.deltaProgressNanoseconds})`,
      )
    const sumMaxDurationsReportGeneration = new BN(input.maxDurationQueryNanoseconds)
      .add(new BN(input.maxDurationObservationNanoseconds))
      .add(new BN(input.maxDurationReportNanoseconds))

    if (sumMaxDurationsReportGeneration.gte(new BN(input.deltaProgressNanoseconds)))
      throw new Error(
        `sum of MaxDurationQuery/Observation/Report (${sumMaxDurationsReportGeneration}) must be less than deltaProgressNanoseconds (${input.deltaProgressNanoseconds})`,
      )

    if (input.rMax <= 0 || input.rMax >= 255)
      throw new Error(`rMax (${input.rMax}) must be greater than zero and less than 255`)

    if (input.s.length >= 1000) throw new Error(`Length of S (${input.s.length}) must be less than 1000`)
    for (let i = 0; i < input.s.length; i++) {
      const s = input.s[i]
      if (s < 0 || s > ORACLES_MAX_LENGTH)
        throw new Error(`S[${i}] (${s}) must be between 0 and Max Oracles (${ORACLES_MAX_LENGTH})`)
    }

    return true
  }

  makeRawTransaction = async (signer: PublicKey): Promise<TransactionInstruction[]> => {
    const proposal = new PublicKey(this.input.proposalId)
    const maxBufferSize = this.flags.bufferSize || MAX_TRANSACTION_BYTES
    this.validateConfig(this.input.offchainConfig)

    logger.info(`Offchain config size: ${this.contractInput.serializedOffchainConfig.byteLength}`)
    this.require(
      this.contractInput.serializedOffchainConfig.byteLength < 4096,
      'Offchain config must be lower than 4096 bytes',
    )

    // There's a byte limit per transaction. Write the config in chunks
    const offchainConfigChunks = divideIntoChunks(this.contractInput.serializedOffchainConfig, maxBufferSize)
    if (offchainConfigChunks.length > 1) {
      logger.info(
        `Config size (${this.contractInput.serializedOffchainConfig.byteLength} bytes) is bigger than transaction limit. It needs to be configured using ${offchainConfigChunks.length} transactions`,
      )
    }

    const ixs = offchainConfigChunks.map((buffer) =>
      this.program.instruction.writeOffchainConfig(buffer, {
        accounts: {
          proposal: proposal,
          authority: signer,
        },
      }),
    )

    return ixs
  }

  buildCommand = async (flags, args) => {
    const ocr2 = getContract(CONTRACT_LIST.OCR_2, '')
    this.program = this.loadProgram(ocr2.idl, ocr2.programId.toString())
    this.input = await this.makeInput(flags.input)
    this.contractInput = await this.makeContractInput(this.input)

    return this
  }

  beforeExecute = async () => {
    const state = new PublicKey(this.args[0])
    const contractState = await this.program.account.state.fetch(state)

    // Config in contract
    const contractOffchainConfig = deserializeConfig(
      Buffer.from(contractState.offchainConfig.xs).slice(0, contractState.offchainConfig.len.toNumber()),
    )
    const contractOffchainConfigForDiff = prepareOffchainConfigForDiff(contractOffchainConfig)

    // Proposed config
    const proposedConfig = deserializeConfig(this.contractInput.serializedOffchainConfig)
    const proposedConfigForDiff = prepareOffchainConfigForDiff(proposedConfig)

    logger.info(`Proposed OffchainConfig for contract ${this.args[0]}`)
    printDiff(contractOffchainConfigForDiff, proposedConfigForDiff)

    logger.info(
      `Important: Save this secret
        - If you run this command for the same configuration, use the same RANDOM SECRET
        - You will need to provide the secret to approve the config proposal
      Provide it with --secret flag`,
    )
    logger.info(`${this.contractInput.randomSecret}`)
    logger.line()

    await prompt('Continue?')
  }

  execute = async () => {
    await this.buildCommand(this.flags, this.args)

    const signer = this.wallet.publicKey
    await this.beforeExecute()

    const state = new PublicKey(this.args[0])
    const rawTx = await this.makeRawTransaction(signer)
    const startingPoint = new BN(this.flags.instruction || 0).toNumber()
    await prompt(`Start writing offchain config from ${startingPoint}/${rawTx.length - 1}?`)

    const txs: string[] = []
    for (let i = startingPoint; i < rawTx.length; i++) {
      await this.simulateTx(signer, [rawTx[i]])
      logger.loading(`Sending ${i}/${rawTx.length - 1}...`)
      const txhash = await this.signAndSendRawTx([rawTx[i]])
      txs.push(txhash)
    }
    logger.success(`Last tx Write offchain config set on tx ${txs[txs.length - 1]}`)

    return {
      data: {
        secret: this.contractInput.randomSecret,
      },
      responses: [
        {
          tx: this.wrapResponse(txs[txs.length - 1], state.toString(), { state: state.toString() }),
          contract: state.toString(),
        },
      ],
    } as Result<TransactionResponse>
  }
}

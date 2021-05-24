import {
  ContractFactory,
  Contract,
  BigNumberish,
  providers,
  Overrides,
  CallOverrides,
  Wallet,
  BigNumber,
  utils as ethersUtils,
  Signer,
  PopulatedTransaction,
} from "ethers";

import { TransactionSubmitter } from "../TransactionSubmitter";
import {
  rpc,
  deployer,
  networkSuffix,
  initGWKAccountIfNeeded,
  isGodwokenDevnet,
} from "../common";

import WalletSimple from "../artifacts/contracts/WalletSimple.sol/WalletSimple.json";
import MintableToken from "../artifacts/contracts/MintableToken.sol/MintableToken.json";
import PolyjuiceAddress from "../artifacts/contracts/PolyjuiceAddress.sol/PolyjuiceAddress.json";

type TCallStatic = Contract["callStatic"];
type TransactionResponse = providers.TransactionResponse;

interface IWalletSimpleStaticMethods extends TCallStatic {
  getNextSequenceId(overrides?: CallOverrides): Promise<BigNumber>;
}

interface IWalletSimple extends Contract, IWalletSimpleStaticMethods {
  callStatic: IWalletSimpleStaticMethods;
  init(
    signers: [string, string, string],
    overrides?: Overrides,
  ): Promise<TransactionResponse>;
  sendMultiSig(
    toAddress: string,
    value: BigNumberish,
    data: string,
    expireTime: number,
    sequenceId: string,
    signature: string,
    overrides?: Overrides,
  ): Promise<TransactionResponse>;
}

interface IPolyjuiceAddressStaticMethods extends TCallStatic {
  getPolyjuiceAddress(overrides?: CallOverrides): Promise<string>;
}

interface IPolyjuiceAddress extends Contract, IPolyjuiceAddressStaticMethods {
  callStatic: IPolyjuiceAddressStaticMethods;
}

interface IMintableTokenStaticMethods extends TCallStatic {
  balanceOf(account: string, overrides?: CallOverrides): Promise<BigNumber>;
}

interface IMintableToken extends Contract, IMintableTokenStaticMethods {
  callStatic: IMintableTokenStaticMethods;
  setMinter(
    minter: string,
    overrides?: Overrides,
  ): Promise<TransactionResponse>;
  mint(
    account: string,
    amount: BigNumberish,
    overrides?: Overrides,
  ): Promise<TransactionResponse>;
  populateTransaction: {
    mint(account: string, amount: BigNumberish): Promise<PopulatedTransaction>;
  };
}

const deployerAddress = deployer.address;

const { SIGNER_PRIVATE_KEYS } = process.env;
if (SIGNER_PRIVATE_KEYS == null) {
  console.log("process.env.SIGNER_PRIVATE_KEYS is required");
  process.exit(1);
}
const signerPrivateKeys = SIGNER_PRIVATE_KEYS.split(",") as [string, string];
if (signerPrivateKeys.length !== 2) {
  console.log(
    "Invalid number of signers, required: 2, got:",
    signerPrivateKeys.length,
  );
  process.exit(1);
}

const [signerOne, signerTwo] = signerPrivateKeys.map(
  (signerPrivateKey) => new Wallet(signerPrivateKey, rpc),
);
const [signerOneAddress, signerTwoAddress] = [signerOne, signerTwo].map(
  (wallet) => wallet.address,
);

const txOverride = {
  gasPrice: isGodwokenDevnet ? 0 : undefined,
  gasLimit: isGodwokenDevnet ? 1_000_000 : undefined,
};

async function main() {
  console.log("Deployer address", deployerAddress);
  await initGWKAccountIfNeeded(deployerAddress);

  const transactionSubmitter = await TransactionSubmitter.newWithHistory(
    `multi-sign-wallet${networkSuffix ? `-${networkSuffix}` : ""}.json`,
  );

  let receipt = await transactionSubmitter.submitAndWait(
    `Deploy WalletSimple`,
    () => {
      const implementationFactory = new ContractFactory(
        WalletSimple.abi,
        WalletSimple.bytecode,
        deployer,
      );
      const tx = implementationFactory.getDeployTransaction();
      tx.gasPrice = txOverride.gasPrice;
      tx.gasLimit = txOverride.gasLimit;
      return deployer.sendTransaction(tx);
    },
  );
  const walletSimpleAddress = receipt.contractAddress;
  console.log(`    WalletSimple address:`, walletSimpleAddress);

  const walletSimple = new Contract(
    walletSimpleAddress,
    WalletSimple.abi,
    deployer,
  ) as IWalletSimple;

  const signerAddresses: [string, string, string] = [
    signerOneAddress,
    signerTwoAddress,
    deployerAddress,
  ];
  if (isGodwokenDevnet) {
    console.log(
      "[Incompatibility] using Polyjuice Address for executor(signer two)",
    );
    await initGWKAccountIfNeeded(signerTwoAddress);

    receipt = await transactionSubmitter.submitAndWait(
      `Deploy PolyjuiceAddress`,
      () => {
        const implementationFactory = new ContractFactory(
          PolyjuiceAddress.abi,
          PolyjuiceAddress.bytecode,
          deployer,
        );
        const tx = implementationFactory.getDeployTransaction();
        tx.gasPrice = txOverride.gasPrice;
        tx.gasLimit = txOverride.gasLimit;
        return deployer.sendTransaction(tx);
      },
    );
    const polyjuiceAddressAddress = receipt.contractAddress;
    console.log("    PolyjuiceAddress address:", polyjuiceAddressAddress);

    const polyjuiceAddress = new Contract(
      polyjuiceAddressAddress,
      PolyjuiceAddress.abi,
      rpc,
    ) as IPolyjuiceAddress;
    const polyjuiceAddressOfSignerTwo =
      await polyjuiceAddress.getPolyjuiceAddress({
        from: signerTwoAddress,
      });
    console.log(
      "    Executor(signer two) Polyjuice Address:",
      polyjuiceAddressOfSignerTwo,
    );
    signerAddresses[1] = polyjuiceAddressOfSignerTwo;
  }

  console.log("Signer addresses:", signerAddresses.join(", "));

  await transactionSubmitter.submitAndWait(`Init WalletSimple`, () => {
    return walletSimple.init(signerAddresses, txOverride);
  });

  receipt = await transactionSubmitter.submitAndWait(
    `Deploy MintableToken`,
    () => {
      const implementationFactory = new ContractFactory(
        MintableToken.abi,
        MintableToken.bytecode,
        deployer,
      );
      const tx = implementationFactory.getDeployTransaction();
      tx.gasPrice = txOverride.gasPrice;
      tx.gasLimit = txOverride.gasLimit;
      return deployer.sendTransaction(tx);
    },
  );
  const mintableTokenAddress = receipt.contractAddress;
  console.log(`    MintableToken address:`, mintableTokenAddress);

  const mintableToken = new Contract(
    mintableTokenAddress,
    MintableToken.abi,
    deployer,
  ) as IMintableToken;

  await transactionSubmitter.submitAndWait(`Set WalletSimple as minter`, () => {
    return mintableToken.setMinter(walletSimpleAddress, txOverride);
  });

  console.log(
    "Balance before mint:",
    (await mintableToken.balanceOf(deployerAddress)).toString(),
  );

  await transactionSubmitter.submitAndWait(
    `Mint 100 using WalletSimple`,
    async () => {
      const walletSimpleForSignerTwo = new Contract(
        walletSimpleAddress,
        WalletSimple.abi,
        signerTwo,
      ) as IWalletSimple;

      const baseTx = await mintableToken.populateTransaction.mint(
        deployerAddress,
        "100",
      );

      const sequenceId = await walletSimple.getNextSequenceId();

      console.log(`    Signing tx using signer one(${signerOneAddress})`);
      const signedTx = await generateSignedTx(
        sequenceId,
        baseTx,
        60,
        signerOne,
      );

      console.log(`    Executing tx using signer two(${signerAddresses[1]})`);
      return walletSimpleForSignerTwo.sendMultiSig(
        signedTx.toAddress,
        signedTx.value.toString(),
        signedTx.data,
        signedTx.expireTime,
        signedTx.sequenceId,
        signedTx.signature,
        txOverride,
      );
    },
  );

  console.log(
    "Balance after mint:",
    (await mintableToken.balanceOf(deployerAddress)).toString(),
  );
}

async function getSignature(
  signer: Signer,
  prefix: string,
  toAddress: string,
  value: string,
  data: string,
  expireTime: number,
  sequenceId: BigNumber,
): Promise<string> {
  const operationHash = ethersUtils.solidityKeccak256(
    ["string", "address", "uint256", "bytes", "uint256", "uint256"],
    [prefix, toAddress, value, data, expireTime, sequenceId],
  );

  return signer.signMessage(ethersUtils.arrayify(operationHash));
}

interface ISignedContractInteractionTx {
  toAddress: string;
  value: string;
  data: string;
  expireTime: number;
  sequenceId: string;
  signature: string;
}

export async function generateSignedTx(
  sequenceId: BigNumber,
  baseTx: PopulatedTransaction,
  expireIn: number,
  signer: Signer,
): Promise<ISignedContractInteractionTx> {
  const expireTime = Date.now() + expireIn * 1000;

  const unsignedTx = {
    toAddress: baseTx.to!,
    value: baseTx.value || "0",
    data: baseTx.data!,
    expireTime,
    sequenceId,
  };

  const signature = await getSignature(
    signer,
    "ETHER",
    unsignedTx.toAddress,
    unsignedTx.value.toString(),
    unsignedTx.data,
    unsignedTx.expireTime,
    unsignedTx.sequenceId,
  );

  return {
    toAddress: unsignedTx.toAddress.toLowerCase(),
    value: unsignedTx.value.toString(),
    data: unsignedTx.data,
    expireTime,
    sequenceId: sequenceId.toString(),
    signature,
  };
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.log("err", err);
    process.exit(1);
  });
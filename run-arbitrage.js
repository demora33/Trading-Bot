require("dotenv").config();
const Web3 = require("web3");
const abis = require("./abis");
const { ChainId, Token, TokenAmount, Pair, Fetcher } = require("@uniswap/sdk");
const { mainnet: addresses } = require("./addresses");
const { parse } = require("dotenv");
const Flashloan = require("./build/contracts/Flashloan.json");

const web3 = new Web3(
  new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);

const { address: admin } = web3.eth.accounts.wallet.add(
  process.env.PRIVATE_KEY
);

const kyber = new web3.eth.Contract(
  abis.kyber.kyberNetworkProxy,
  addresses.kyber.kyberNetworkProxy
);

const AMOUNT_ETH = 100;

const RECENT_ETH_PRICE = 1780;

const AMOUNT_ETH_WEI = web3.utils.toWei(AMOUNT_ETH.toString());

const AMOUNT_DAI_WEI = web3.utils.toWei(
  (AMOUNT_ETH * RECENT_ETH_PRICE).toString()
);

const DIRECTION = {
  KYBER_TO_UNISWAP: 0,
  UNISWAP_TO_KYBER: 1,
};

const init = async () => {
  const networkId = await web3.eth.net.getId();
  const flashloan = new web3.eth.Contract(
    Flashloan.abi,
    Flashloan.networks[networkId].addresses
  );
  const [dai, weth] = await Promise.all(
    [addresses.tokens.dai, addresses.tokens.weth].map((tokenAddress) =>
      Fetcher.fetchTokenData(ChainId.MAINNET, tokenAddress)
    )
  );

  const daiWeth = await Fetcher.fetchPairData(dai, weth);

  //   console.log("dai", dai);
  //   console.log("weth", weth);
  //   console.log("daiWeth", daiWeth);

  web3.eth
    .subscribe("newBlockHeaders")
    .on("data", async (block) => {
      console.log("New block received. Block:", block.number);

      const kyberResults = await Promise.all([
        kyber.methods
          .getExpectedRate(
            addresses.tokens.dai,
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            AMOUNT_DAI_WEI
          )
          .call(),
        kyber.methods
          .getExpectedRate(
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            addresses.tokens.dai,
            AMOUNT_ETH_WEI
          )
          .call(),
      ]);

      const kyberRates = {
        buy: 1 / parseFloat(kyberResults[0].expectedRate / 10 ** 18),
        sell: parseFloat(kyberResults[1].expectedRate / 10 ** 18),
      };

      //   console.log("kyberRates", kyberRates);

      const uniswapResults = await Promise.all([
        daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
        daiWeth.getOutputAmount(new TokenAmount(weth, AMOUNT_ETH_WEI)),
      ]);

      const uniswapRates = {
        buy: parseFloat(
          AMOUNT_DAI_WEI / (uniswapResults[0][0].toExact() * 10 ** 18)
        ),
        sell: parseFloat(uniswapResults[1][0].toExact() / AMOUNT_ETH),
      };

      //   console.log("uniswapRates", uniswapRates);

      // CALCULO DEL BENEFICIO
      // SE DEBE TENER EN CUENTA EL GAS USADO POR TX (DEPENDE DE LA RED, CONGESTION, ETC..)

      // PROFIT1 ---> COMPRO EHT EN KYBER Y VENDO EN UNISWAP
      // PROFIT2 ---> COMPRO EHT EN UNISWAP Y VENDO EN KYBER

      const [tx1, tx2] = Object.keys(DIRECTION).map((direction) =>
        flashloan.methods.initiateFlashloan(
          addresses.dydx.solo,
          addresses.tokens.dai,
          AMOUNT_DAI_WEI,
          direction
        )
      );

      const [gasPrice, gasCost1, gasCost2] = await Promise.all([
        await web3.eth.getGasPrice(),
        tx1.estimateGas({ from: admin }),
        tx2.estimateGas({ from: admin }),
      ]);
      const txCost1 = parseInt(gasCost1) + parseInt(gasPrice);
      const txCost2 = parseInt(gasCost2) + parseInt(gasPrice);
      const currentEthPrice = (uniswapRates.buy - uniswapRates.sell) / 2;

      const profit1 =
        (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) *
          (uniswapRates.sell - kyberRates.buy) -
        (txCost1 / 10 ** 18) * currentEthPrice;

      const profit2 =
        (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) *
          (kyberRates.sell - uniswapRates.buy) -
        (txCost2 / 10 ** 18) * currentEthPrice;

      if (profit1 > 0) {
        console.log("Arbitrage opportunity found");
        console.log("Buy ETH on Kyber at", kyberRates.buy), "dai";
        console.log("Sell ETH on Uniswap at", uniswapRates.sell, "dai");
        console.log("BENEFICIO ENCONTRADO:", profit1, "dai");
        const data = tx1.encodeABI();
        const txData = {
          from: admin,
          to: flashloan.options.address,
          data,
          gas: gasCost1,
          gasPrice,
        };
        const receipt = await web3.eth.sendTransaction(txData);
        console.log("TX HASH", receipt.transactionHash);
      } else if (profit2 > 0) {
        console.log("Arbitrage opportunity found");
        console.log("Buy ETH on Uniswap at", uniswapRates.buy), "dai";
        console.log("Sell ETH on Kyber at", kyberRates.sell, "dai");
        console.log("BENEFICIO ENCONTRADO:", profit2, "dai");
      }
    })
    .on("error", (error) => {
      console.log(error);
    });
};

init();

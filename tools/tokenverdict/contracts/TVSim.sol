// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TokenVerdict sell simulator. Never deployed: its runtime bytecode is placed at a throwaway address through an
// eth_call state override (with an ETH balance, or a quote-token balance override), so nothing is ever sent on chain.
// One call: buy `token` with `amountIn` of `quote` directly on `pool`, send a slice to a fresh wallet (transfer test),
// then sell the rest back on the same pool. Every step is try/catch so the result reports where it failed.
interface IERC20 { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); }
interface IWETH { function deposit() external payable; }
interface IV2 { function getReserves() external view returns (uint112, uint112, uint32); function token0() external view returns (address); function swap(uint256, uint256, address, bytes calldata) external; }
interface ISolidly { function getAmountOut(uint256, address) external view returns (uint256); }
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IPM {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(PoolKey memory, SwapParams memory, bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}
interface IV3 { function token0() external view returns (address); function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256); }

contract TVSim {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273103530467335439183471;
    address constant WALLET = 0x7E57000000000000000000000000000000007E57;

    struct R {
        bool funded; bool buyOk; bool transferOk; bool sellTransferOk; bool sellOk;
        uint256 buyExpected; uint256 buyReceived;
        uint256 transferSent; uint256 transferReceived;
        uint256 sellAmount; uint256 poolReceived; uint256 sellExpected; uint256 sellReceived;
        uint256 buyGas; uint256 sellGas;
        bytes buyErr; bytes sellErr;
    }

    address private cbToken; // token the active V3 callback must pay

    // kind: 1 = Uniswap V2 fork (0.3% fee assumed, 1% retry), 2 = Solidly / Aerodrome classic, 3 = V3-style concentrated liquidity
    function run(address pool, uint8 kind, address token, address quote, uint256 amountIn) external returns (R memory r) {
        if (quote == WETH && IERC20(WETH).balanceOf(address(this)) < amountIn) IWETH(WETH).deposit{value: amountIn}();
        r.funded = IERC20(quote).balanceOf(address(this)) >= amountIn;
        if (!r.funded) return r;

        // ---- buy ----
        uint256 b0 = IERC20(token).balanceOf(address(this));
        uint256 g = gasleft();
        if (kind == 3) {
            bool zf = IV3(pool).token0() == quote;
            cbToken = quote;
            try IV3(pool).swap(address(this), zf, int256(amountIn), zf ? MIN_SQRT : MAX_SQRT, "") returns (int256 a0, int256 a1) {
                r.buyOk = true; r.buyExpected = uint256(-(zf ? a1 : a0));
            } catch (bytes memory e) { r.buyErr = e; }
        } else {
            (bool ok, bytes memory e) = _v2Buy(pool, kind, token, quote, amountIn, r);
            r.buyOk = ok; if (!ok) r.buyErr = e;
        }
        r.buyGas = g - gasleft();
        if (!r.buyOk) return r;
        r.buyReceived = IERC20(token).balanceOf(address(this)) - b0;
        if (r.buyReceived == 0) return r;

        // ---- wallet transfer test (10%) ----
        r.transferSent = r.buyReceived / 10;
        if (r.transferSent > 0) {
            uint256 w0 = IERC20(token).balanceOf(WALLET);
            (bool ok,) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, WALLET, r.transferSent));
            r.transferOk = ok;
            if (ok) r.transferReceived = IERC20(token).balanceOf(WALLET) - w0;
        }

        // ---- sell ----
        r.sellAmount = IERC20(token).balanceOf(address(this));
        uint256 q0 = IERC20(quote).balanceOf(address(this));
        g = gasleft();
        if (kind == 3) {
            bool zf = IV3(pool).token0() == token;
            cbToken = token;
            try IV3(pool).swap(address(this), zf, int256(r.sellAmount), zf ? MIN_SQRT : MAX_SQRT, "") returns (int256 a0, int256 a1) {
                r.sellOk = true; r.sellTransferOk = true; r.poolReceived = uint256(zf ? a0 : a1); r.sellExpected = uint256(-(zf ? a1 : a0));
            } catch (bytes memory e) { r.sellErr = e; }
        } else {
            uint256 p0 = IERC20(token).balanceOf(pool);
            (bool ok, bytes memory e) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, pool, r.sellAmount));
            if (!ok) { r.sellErr = e; }
            else {
                r.sellTransferOk = true;
                r.poolReceived = IERC20(token).balanceOf(pool) - p0;
                (ok, e) = _v2Sell(pool, kind, token, quote, r);
                r.sellOk = ok; if (!ok) r.sellErr = e;
            }
        }
        r.sellGas = g - gasleft();
        if (r.sellOk) r.sellReceived = IERC20(quote).balanceOf(address(this)) - q0;
    }

    function _out(address pool, uint8 kind, address tokenIn, uint256 amtIn, uint256 feeBps) internal view returns (uint256) {
        if (kind == 2) return ISolidly(pool).getAmountOut(amtIn, tokenIn);
        (uint112 r0, uint112 r1,) = IV2(pool).getReserves();
        bool zIn = IV2(pool).token0() == tokenIn;
        uint256 rin = zIn ? r0 : r1; uint256 rout = zIn ? r1 : r0;
        uint256 a = amtIn * (10000 - feeBps);
        return (a * rout) / (rin * 10000 + a);
    }

    function _swapOut(address pool, address tokenOut, uint256 out) internal returns (bool ok, bytes memory e) {
        bool z = IV2(pool).token0() == tokenOut;
        try IV2(pool).swap(z ? out : 0, z ? 0 : out, address(this), "") { ok = true; } catch (bytes memory err) { e = err; }
    }

    function _v2Buy(address pool, uint8 kind, address token, address quote, uint256 amountIn, R memory r) internal returns (bool ok, bytes memory e) {
        uint256 out = _out(pool, kind, quote, amountIn, 30);
        r.buyExpected = out;
        IERC20(quote).transfer(pool, amountIn);
        (ok, e) = _swapOut(pool, token, out);
        if (!ok && kind == 1) { out = _out(pool, kind, quote, amountIn, 100); r.buyExpected = out; (ok, e) = _swapOut(pool, token, out); }
    }

    function _v2Sell(address pool, uint8 kind, address token, address quote, R memory r) internal returns (bool ok, bytes memory e) {
        uint256 out = _out(pool, kind, token, r.poolReceived, 30);
        r.sellExpected = out;
        (ok, e) = _swapOut(pool, quote, out);
        if (!ok && kind == 1) { out = _out(pool, kind, token, r.poolReceived, 100); r.sellExpected = out; (ok, e) = _swapOut(pool, quote, out); }
    }

    // ---- Uniswap v4 (singleton PoolManager, flash accounting) ----
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    function _bal(address c, address who) internal view returns (uint256) { return c == address(0) ? who.balance : IERC20(c).balanceOf(who); }

    function run4(PoolKey calldata key, address token, uint256 amountIn) external returns (R memory r) {
        address quote = key.currency0 == token ? key.currency1 : key.currency0;
        if (quote == WETH && IERC20(WETH).balanceOf(address(this)) < amountIn) IWETH(WETH).deposit{value: amountIn}();
        r.funded = _bal(quote, address(this)) >= amountIn;
        if (!r.funded) return r;
        uint256 b0 = IERC20(token).balanceOf(address(this));
        uint256 g = gasleft();
        try IPM(PM).unlock(abi.encode(uint8(1), key, token, quote, amountIn)) returns (bytes memory ret) {
            r.buyOk = true; r.buyExpected = abi.decode(ret, (uint256));
        } catch (bytes memory e) { r.buyErr = e; }
        r.buyGas = g - gasleft();
        if (!r.buyOk) return r;
        r.buyReceived = IERC20(token).balanceOf(address(this)) - b0;
        if (r.buyReceived == 0) return r;
        r.transferSent = r.buyReceived / 10;
        if (r.transferSent > 0) {
            uint256 w0 = IERC20(token).balanceOf(WALLET);
            (bool ok,) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, WALLET, r.transferSent));
            r.transferOk = ok;
            if (ok) r.transferReceived = IERC20(token).balanceOf(WALLET) - w0;
        }
        r.sellAmount = IERC20(token).balanceOf(address(this));
        uint256 q0 = _bal(quote, address(this));
        g = gasleft();
        try IPM(PM).unlock(abi.encode(uint8(2), key, token, quote, r.sellAmount)) returns (bytes memory ret) {
            r.sellOk = true; r.sellTransferOk = true;
            (r.poolReceived, r.sellExpected) = abi.decode(ret, (uint256, uint256));
        } catch (bytes memory e) { r.sellErr = e; }
        r.sellGas = g - gasleft();
        if (r.sellOk) r.sellReceived = _bal(quote, address(this)) - q0;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == PM, "pm");
        (uint8 stage, PoolKey memory key, address token, address quote, uint256 amt) = abi.decode(data, (uint8, PoolKey, address, address, uint256));
        if (stage == 1) {
            bool zf = key.currency0 == quote;
            int256 d = IPM(PM).swap(key, SwapParams(zf, -int256(amt), zf ? MIN_SQRT : MAX_SQRT), "");
            int128 qd = zf ? int128(d >> 128) : int128(d);
            int128 td = zf ? int128(d) : int128(d >> 128);
            _settle(quote, uint256(uint128(-qd)));
            IPM(PM).take(token, address(this), uint256(uint128(td)));
            return abi.encode(uint256(uint128(td)));
        }
        // stage 2: pay the tokens in first (settle credits what the PoolManager actually received), then swap exactly that
        IPM(PM).sync(token);
        IERC20(token).transfer(PM, amt);
        uint256 paid = IPM(PM).settle();
        bool zf2 = key.currency0 == token;
        int256 d2 = IPM(PM).swap(key, SwapParams(zf2, -int256(paid), zf2 ? MIN_SQRT : MAX_SQRT), "");
        int128 qd2 = zf2 ? int128(d2) : int128(d2 >> 128);
        int128 td2 = zf2 ? int128(d2 >> 128) : int128(d2);
        if (td2 < 0 && uint256(uint128(-td2)) < paid) IPM(PM).take(token, address(this), paid - uint256(uint128(-td2)));
        IPM(PM).take(quote, address(this), uint256(uint128(qd2)));
        return abi.encode(paid, uint256(uint128(qd2)));
    }
    function _settle(address c, uint256 amt) internal {
        if (c == address(0)) { IPM(PM).settle{value: amt}(); return; }
        IPM(PM).sync(c);
        IERC20(c).transfer(PM, amt);
        IPM(PM).settle();
    }

    function _pay(int256 a0, int256 a1) internal {
        uint256 owed = uint256(a0 > 0 ? a0 : a1);
        IERC20(cbToken).transfer(msg.sender, owed);
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    receive() external payable {}
}

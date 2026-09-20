// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.28 >=0.7.0 ^0.8.20 ^0.8.21;

// lib/openzeppelin-contracts/contracts/utils/Errors.sol

// OpenZeppelin Contracts (last updated v5.1.0) (utils/Errors.sol)

/**
 * @dev Collection of common custom errors used in multiple contracts
 *
 * IMPORTANT: Backwards compatibility is not guaranteed in future versions of the library.
 * It is recommended to avoid relying on the error API for critical functionality.
 *
 * _Available since v5.1._
 */
library Errors {
    /**
     * @dev The ETH balance of the account is not enough to perform the operation.
     */
    error InsufficientBalance(uint256 balance, uint256 needed);

    /**
     * @dev A call to an address target failed. The target may have reverted.
     */
    error FailedCall();

    /**
     * @dev The deployment failed.
     */
    error FailedDeployment();

    /**
     * @dev A necessary precompile is missing.
     */
    error MissingPrecompile(address);
}

// lib/openzeppelin-contracts/contracts/proxy/beacon/IBeacon.sol

// OpenZeppelin Contracts (last updated v5.0.0) (proxy/beacon/IBeacon.sol)

/**
 * @dev This is the interface that {BeaconProxy} expects of its beacon.
 */
interface IBeacon {
    /**
     * @dev Must return an address that can be used as a delegate call target.
     *
     * {UpgradeableBeacon} will check that this address is a contract.
     */
    function implementation() external view returns (address);
}

// lib/openzeppelin-contracts/contracts/interfaces/IERC1967.sol

// OpenZeppelin Contracts (last updated v5.0.0) (interfaces/IERC1967.sol)

/**
 * @dev ERC-1967: Proxy Storage Slots. This interface contains the events defined in the ERC.
 */
interface IERC1967 {
    /**
     * @dev Emitted when the implementation is upgraded.
     */
    event Upgraded(address indexed implementation);

    /**
     * @dev Emitted when the admin account has changed.
     */
    event AdminChanged(address previousAdmin, address newAdmin);

    /**
     * @dev Emitted when the beacon is changed.
     */
    event BeaconUpgraded(address indexed beacon);
}

// lib/openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (proxy/utils/Initializable.sol)

/**
 * @dev This is a base contract to aid in writing upgradeable contracts, or any kind of contract that will be deployed
 * behind a proxy. Since proxied contracts do not make use of a constructor, it's common to move constructor logic to an
 * external initializer function, usually called `initialize`. It then becomes necessary to protect this initializer
 * function so it can only be called once. The {initializer} modifier provided by this contract will have this effect.
 *
 * The initialization functions use a version number. Once a version number is used, it is consumed and cannot be
 * reused. This mechanism prevents re-execution of each "step" but allows the creation of new initialization steps in
 * case an upgrade adds a module that needs to be initialized.
 *
 * For example:
 *
 * [.hljs-theme-light.nopadding]
 * ```solidity
 * contract MyToken is ERC20Upgradeable {
 *     function initialize() initializer public {
 *         __ERC20_init("MyToken", "MTK");
 *     }
 * }
 *
 * contract MyTokenV2 is MyToken, ERC20PermitUpgradeable {
 *     function initializeV2() reinitializer(2) public {
 *         __ERC20Permit_init("MyToken");
 *     }
 * }
 * ```
 *
 * TIP: To avoid leaving the proxy in an uninitialized state, the initializer function should be called as early as
 * possible by providing the encoded function call as the `_data` argument to {ERC1967Proxy-constructor}.
 *
 * CAUTION: When used with inheritance, manual care must be taken to not invoke a parent initializer twice, or to ensure
 * that all initializers are idempotent. This is not verified automatically as constructors are by Solidity.
 *
 * [CAUTION]
 * ====
 * Avoid leaving a contract uninitialized.
 *
 * An uninitialized contract can be taken over by an attacker. This applies to both a proxy and its implementation
 * contract, which may impact the proxy. To prevent the implementation contract from being used, you should invoke
 * the {_disableInitializers} function in the constructor to automatically lock it when it is deployed:
 *
 * [.hljs-theme-light.nopadding]
 * ```
 * /// @custom:oz-upgrades-unsafe-allow constructor
 * constructor() {
 *     _disableInitializers();
 * }
 * ```
 * ====
 */
abstract contract Initializable {
    /**
     * @dev Storage of the initializable contract.
     *
     * It's implemented on a custom ERC-7201 namespace to reduce the risk of storage collisions
     * when using with upgradeable contracts.
     *
     * @custom:storage-location erc7201:openzeppelin.storage.Initializable
     */
    struct InitializableStorage {
        /**
         * @dev Indicates that the contract has been initialized.
         */
        uint64 _initialized;
        /**
         * @dev Indicates that the contract is in the process of being initialized.
         */
        bool _initializing;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    /**
     * @dev The contract is already initialized.
     */
    error InvalidInitialization();

    /**
     * @dev The contract is not initializing.
     */
    error NotInitializing();

    /**
     * @dev Triggered when the contract has been initialized or reinitialized.
     */
    event Initialized(uint64 version);

    /**
     * @dev A modifier that defines a protected initializer function that can be invoked at most once. In its scope,
     * `onlyInitializing` functions can be used to initialize parent contracts.
     *
     * Similar to `reinitializer(1)`, except that in the context of a constructor an `initializer` may be invoked any
     * number of times. This behavior in the constructor can be useful during testing and is not expected to be used in
     * production.
     *
     * Emits an {Initialized} event.
     */
    modifier initializer() {
        // solhint-disable-next-line var-name-mixedcase
        InitializableStorage storage $ = _getInitializableStorage();

        // Cache values to avoid duplicated sloads
        bool isTopLevelCall = !$._initializing;
        uint64 initialized = $._initialized;

        // Allowed calls:
        // - initialSetup: the contract is not in the initializing state and no previous version was
        //                 initialized
        // - construction: the contract is initialized at version 1 (no reininitialization) and the
        //                 current contract is just being deployed
        bool initialSetup = initialized == 0 && isTopLevelCall;
        bool construction = initialized == 1 && address(this).code.length == 0;

        if (!initialSetup && !construction) {
            revert InvalidInitialization();
        }
        $._initialized = 1;
        if (isTopLevelCall) {
            $._initializing = true;
        }
        _;
        if (isTopLevelCall) {
            $._initializing = false;
            emit Initialized(1);
        }
    }

    /**
     * @dev A modifier that defines a protected reinitializer function that can be invoked at most once, and only if the
     * contract hasn't been initialized to a greater version before. In its scope, `onlyInitializing` functions can be
     * used to initialize parent contracts.
     *
     * A reinitializer may be used after the original initialization step. This is essential to configure modules that
     * are added through upgrades and that require initialization.
     *
     * When `version` is 1, this modifier is similar to `initializer`, except that functions marked with `reinitializer`
     * cannot be nested. If one is invoked in the context of another, execution will revert.
     *
     * Note that versions can jump in increments greater than 1; this implies that if multiple reinitializers coexist in
     * a contract, executing them in the right order is up to the developer or operator.
     *
     * WARNING: Setting the version to 2**64 - 1 will prevent any future reinitialization.
     *
     * Emits an {Initialized} event.
     */
    modifier reinitializer(uint64 version) {
        // solhint-disable-next-line var-name-mixedcase
        InitializableStorage storage $ = _getInitializableStorage();

        if ($._initializing || $._initialized >= version) {
            revert InvalidInitialization();
        }
        $._initialized = version;
        $._initializing = true;
        _;
        $._initializing = false;
        emit Initialized(version);
    }

    /**
     * @dev Modifier to protect an initialization function so that it can only be invoked by functions with the
     * {initializer} and {reinitializer} modifiers, directly or indirectly.
     */
    modifier onlyInitializing() {
        _checkInitializing();
        _;
    }

    /**
     * @dev Reverts if the contract is not in an initializing state. See {onlyInitializing}.
     */
    function _checkInitializing() internal view virtual {
        if (!_isInitializing()) {
            revert NotInitializing();
        }
    }

    /**
     * @dev Locks the contract, preventing any future reinitialization. This cannot be part of an initializer call.
     * Calling this in the constructor of a contract will prevent that contract from being initialized or reinitialized
     * to any version. It is recommended to use this to lock implementation contracts that are designed to be called
     * through proxies.
     *
     * Emits an {Initialized} event the first time it is successfully executed.
     */
    function _disableInitializers() internal virtual {
        // solhint-disable-next-line var-name-mixedcase
        InitializableStorage storage $ = _getInitializableStorage();

        if ($._initializing) {
            revert InvalidInitialization();
        }
        if ($._initialized != type(uint64).max) {
            $._initialized = type(uint64).max;
            emit Initialized(type(uint64).max);
        }
    }

    /**
     * @dev Returns the highest version that has been initialized. See {reinitializer}.
     */
    function _getInitializedVersion() internal view returns (uint64) {
        return _getInitializableStorage()._initialized;
    }

    /**
     * @dev Returns `true` if the contract is currently initializing. See {onlyInitializing}.
     */
    function _isInitializing() internal view returns (bool) {
        return _getInitializableStorage()._initializing;
    }

    /**
     * @dev Returns a pointer to the storage namespace.
     */
    // solhint-disable-next-line var-name-mixedcase
    function _getInitializableStorage() private pure returns (InitializableStorage storage $) {
        assembly {
            $.slot := INITIALIZABLE_STORAGE
        }
    }
}

// lib/poseidon-solidity/PoseidonT4.sol

library PoseidonT4 {
  uint constant F = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

  uint constant M00 = 0x236d13393ef85cc48a351dd786dd7a1de5e39942296127fd87947223ae5108ad;
  uint constant M01 = 0x2a75a171563b807db525be259699ab28fe9bc7fb1f70943ff049bc970e841a0c;
  uint constant M02 = 0x2070679e798782ef592a52ca9cef820d497ad2eecbaa7e42f366b3e521c4ed42;
  uint constant M03 = 0x2f545e578202c9732488540e41f783b68ff0613fd79375f8ba8b3d30958e7677;
  uint constant M10 = 0x277686494f7644bbc4a9b194e10724eb967f1dc58718e59e3cedc821b2a7ae19;
  uint constant M11 = 0x083abff5e10051f078e2827d092e1ae808b4dd3e15ccc3706f38ce4157b6770e;
  uint constant M12 = 0x2e18c8570d20bf5df800739a53da75d906ece318cd224ab6b3a2be979e2d7eab;
  uint constant M13 = 0x23810bf82877fc19bff7eefeae3faf4bb8104c32ba4cd701596a15623d01476e;
  uint constant M20 = 0x023db68784e3f0cc0b85618826a9b3505129c16479973b0a84a4529e66b09c62;
  uint constant M21 = 0x1a5ad71bbbecd8a97dc49cfdbae303ad24d5c4741eab8b7568a9ff8253a1eb6f;
  uint constant M22 = 0x0fa86f0f27e4d3dd7f3367ce86f684f1f2e4386d3e5b9f38fa283c6aa723b608;
  uint constant M23 = 0x014fcd5eb0be6d5beeafc4944034cf321c068ef930f10be2207ed58d2a34cdd6;
  uint constant M30 = 0x1d359d245f286c12d50d663bae733f978af08cdbd63017c57b3a75646ff382c1;
  uint constant M31 = 0x0d745fd00dd167fb86772133640f02ce945004a7bc2c59e8790f725c5d84f0af;
  uint constant M32 = 0x03f3e6fab791f16628168e4b14dbaeb657035ee3da6b2ca83f0c2491e0b403eb;
  uint constant M33 = 0x00c15fc3a1d5733dd835eae0823e377f8ba4a8b627627cc2bb661c25d20fb52a;

  // See here for a simplified implementation: https://github.com/vimwitch/poseidon-solidity/blob/e57becdabb65d99fdc586fe1e1e09e7108202d53/contracts/Poseidon.sol#L40
  // Inspired by: https://github.com/iden3/circomlibjs/blob/v0.0.8/src/poseidon_slow.js
  function hash(uint[3] memory) public pure returns (uint) {
    assembly {
      // memory 0x00 to 0x3f (64 bytes) is scratch space for hash algos
      // we can use it in inline assembly because we're not calling e.g. keccak
      //
      // memory 0x80 is the default offset for free memory
      // we take inputs as a memory argument so we simply write over
      // that memory after loading it

      // we have the following variables at memory offsets
      // state0 - 0x00
      // state1 - 0x20
      // state2 - 0x80
      // state3 - 0xa0
      // state4 - ...

      function pRound(c0, c1, c2, c3) {
        let state0 := add(mload(0x0), c0)
        let state1 := add(mload(0x20), c1)
        let state2 := add(mload(0x80), c2)
        let state3 := add(mload(0xa0), c3)

        let p := mulmod(state0, state0, F)
        state0 := mulmod(mulmod(p, p, F), state0, F)

        mstore(0x0, mod(add(add(add(mulmod(state0, M00, F), mulmod(state1, M10, F)), mulmod(state2, M20, F)), mulmod(state3, M30, F)), F))
        mstore(0x20, mod(add(add(add(mulmod(state0, M01, F), mulmod(state1, M11, F)), mulmod(state2, M21, F)), mulmod(state3, M31, F)), F))
        mstore(0x80, mod(add(add(add(mulmod(state0, M02, F), mulmod(state1, M12, F)), mulmod(state2, M22, F)), mulmod(state3, M32, F)), F))
        mstore(0xa0, mod(add(add(add(mulmod(state0, M03, F), mulmod(state1, M13, F)), mulmod(state2, M23, F)), mulmod(state3, M33, F)), F))
      }

      function fRound(c0, c1, c2, c3) {
        let state0 := add(mload(0x0), c0)
        let state1 := add(mload(0x20), c1)
        let state2 := add(mload(0x80), c2)
        let state3 := add(mload(0xa0), c3)

        let p := mulmod(state0, state0, F)
        state0 := mulmod(mulmod(p, p, F), state0, F)
        p := mulmod(state1, state1, F)
        state1 := mulmod(mulmod(p, p, F), state1, F)
        p := mulmod(state2, state2, F)
        state2 := mulmod(mulmod(p, p, F), state2, F)
        p := mulmod(state3, state3, F)
        state3 := mulmod(mulmod(p, p, F), state3, F)

        mstore(0x0, mod(add(add(add(mulmod(state0, M00, F), mulmod(state1, M10, F)), mulmod(state2, M20, F)), mulmod(state3, M30, F)), F))
        mstore(0x20, mod(add(add(add(mulmod(state0, M01, F), mulmod(state1, M11, F)), mulmod(state2, M21, F)), mulmod(state3, M31, F)), F))
        mstore(0x80, mod(add(add(add(mulmod(state0, M02, F), mulmod(state1, M12, F)), mulmod(state2, M22, F)), mulmod(state3, M32, F)), F))
        mstore(0xa0, mod(add(add(add(mulmod(state0, M03, F), mulmod(state1, M13, F)), mulmod(state2, M23, F)), mulmod(state3, M33, F)), F))
      }

      // scratch variable for exponentiation
      let p

      {
        // load the inputs from memory
        let state1 := add(mod(mload(0x80), F), 0x265ddfe127dd51bd7239347b758f0a1320eb2cc7450acc1dad47f80c8dcf34d6)
        let state2 := add(mod(mload(0xa0), F), 0x199750ec472f1809e0f66a545e1e51624108ac845015c2aa3dfc36bab497d8aa)
        let state3 := add(mod(mload(0xc0), F), 0x157ff3fe65ac7208110f06a5f74302b14d743ea25067f0ffd032f787c7f1cdf8)

        p := mulmod(state1, state1, F)
        state1 := mulmod(mulmod(p, p, F), state1, F)
        p := mulmod(state2, state2, F)
        state2 := mulmod(mulmod(p, p, F), state2, F)
        p := mulmod(state3, state3, F)
        state3 := mulmod(mulmod(p, p, F), state3, F)

        // state0 pow5mod and M[] multiplications are pre-calculated

        mstore(
          0x0,
          mod(add(add(add(0x211184aac7468125da9b5527788aed6331caa8335774fe66f16acc6c66c456d7, mulmod(state1, M10, F)), mulmod(state2, M20, F)), mulmod(state3, M30, F)), F)
        )
        mstore(
          0x20,
          mod(add(add(add(0x19764435729b98150ca53b559b7b1bdd91692d645e831f4a30d30d510792687a, mulmod(state1, M11, F)), mulmod(state2, M21, F)), mulmod(state3, M31, F)), F)
        )
        mstore(
          0x80,
          mod(add(add(add(0x21f642c132b82c867835f1753eecedd4679085e8c78f6a0ae4a8cd81e9834bdf, mulmod(state1, M12, F)), mulmod(state2, M22, F)), mulmod(state3, M32, F)), F)
        )
        mstore(
          0xa0,
          mod(add(add(add(0x26bc2b5c607af61196105d955bd3d9b2cf795edcf9e39d1e508c542ca85d6be3, mulmod(state1, M13, F)), mulmod(state2, M23, F)), mulmod(state3, M33, F)), F)
        )
      }

      fRound(
        0x2e49c43c4569dd9c5fd35ac45fca33f10b15c590692f8beefe18f4896ac94902,
        0x0e35fb89981890520d4aef2b6d6506c3cb2f0b6973c24fa82731345ffa2d1f1e,
        0x251ad47cb15c4f1105f109ae5e944f1ba9d9e7806d667ffec6fe723002e0b996,
        0x13da07dc64d428369873e97160234641f8beb56fdd05e5f3563fa39d9c22df4e
      )

      fRound(
        0x0c009b84e650e6d23dc00c7dccef7483a553939689d350cd46e7b89055fd4738,
        0x011f16b1c63a854f01992e3956f42d8b04eb650c6d535eb0203dec74befdca06,
        0x0ed69e5e383a688f209d9a561daa79612f3f78d0467ad45485df07093f367549,
        0x04dba94a7b0ce9e221acad41472b6bbe3aec507f5eb3d33f463672264c9f789b
      )

      fRound(
        0x0a3f2637d840f3a16eb094271c9d237b6036757d4bb50bf7ce732ff1d4fa28e8,
        0x259a666f129eea198f8a1c502fdb38fa39b1f075569564b6e54a485d1182323f,
        0x28bf7459c9b2f4c6d8e7d06a4ee3a47f7745d4271038e5157a32fdf7ede0d6a1,
        0x0a1ca941f057037526ea200f489be8d4c37c85bbcce6a2aeec91bd6941432447
      )

      pRound(
        0x0c6f8f958be0e93053d7fd4fc54512855535ed1539f051dcb43a26fd926361cf,
        0x123106a93cd17578d426e8128ac9d90aa9e8a00708e296e084dd57e69caaf811,
        0x26e1ba52ad9285d97dd3ab52f8e840085e8fa83ff1e8f1877b074867cd2dee75,
        0x1cb55cad7bd133de18a64c5c47b9c97cbe4d8b7bf9e095864471537e6a4ae2c5
      )

      pRound(
        0x1dcd73e46acd8f8e0e2c7ce04bde7f6d2a53043d5060a41c7143f08e6e9055d0,
        0x011003e32f6d9c66f5852f05474a4def0cda294a0eb4e9b9b12b9bb4512e5574,
        0x2b1e809ac1d10ab29ad5f20d03a57dfebadfe5903f58bafed7c508dd2287ae8c,
        0x2539de1785b735999fb4dac35ee17ed0ef995d05ab2fc5faeaa69ae87bcec0a5
      )

      pRound(
        0x0c246c5a2ef8ee0126497f222b3e0a0ef4e1c3d41c86d46e43982cb11d77951d,
        0x192089c4974f68e95408148f7c0632edbb09e6a6ad1a1c2f3f0305f5d03b527b,
        0x1eae0ad8ab68b2f06a0ee36eeb0d0c058529097d91096b756d8fdc2fb5a60d85,
        0x179190e5d0e22179e46f8282872abc88db6e2fdc0dee99e69768bd98c5d06bfb
      )

      pRound(
        0x29bb9e2c9076732576e9a81c7ac4b83214528f7db00f31bf6cafe794a9b3cd1c,
        0x225d394e42207599403efd0c2464a90d52652645882aac35b10e590e6e691e08,
        0x064760623c25c8cf753d238055b444532be13557451c087de09efd454b23fd59,
        0x10ba3a0e01df92e87f301c4b716d8a394d67f4bf42a75c10922910a78f6b5b87
      )

      pRound(
        0x0e070bf53f8451b24f9c6e96b0c2a801cb511bc0c242eb9d361b77693f21471c,
        0x1b94cd61b051b04dd39755ff93821a73ccd6cb11d2491d8aa7f921014de252fb,
        0x1d7cb39bafb8c744e148787a2e70230f9d4e917d5713bb050487b5aa7d74070b,
        0x2ec93189bd1ab4f69117d0fe980c80ff8785c2961829f701bb74ac1f303b17db
      )

      pRound(
        0x2db366bfdd36d277a692bb825b86275beac404a19ae07a9082ea46bd83517926,
        0x062100eb485db06269655cf186a68532985275428450359adc99cec6960711b8,
        0x0761d33c66614aaa570e7f1e8244ca1120243f92fa59e4f900c567bf41f5a59b,
        0x20fc411a114d13992c2705aa034e3f315d78608a0f7de4ccf7a72e494855ad0d
      )

      pRound(
        0x25b5c004a4bdfcb5add9ec4e9ab219ba102c67e8b3effb5fc3a30f317250bc5a,
        0x23b1822d278ed632a494e58f6df6f5ed038b186d8474155ad87e7dff62b37f4b,
        0x22734b4c5c3f9493606c4ba9012499bf0f14d13bfcfcccaa16102a29cc2f69e0,
        0x26c0c8fe09eb30b7e27a74dc33492347e5bdff409aa3610254413d3fad795ce5
      )

      pRound(
        0x070dd0ccb6bd7bbae88eac03fa1fbb26196be3083a809829bbd626df348ccad9,
        0x12b6595bdb329b6fb043ba78bb28c3bec2c0a6de46d8c5ad6067c4ebfd4250da,
        0x248d97d7f76283d63bec30e7a5876c11c06fca9b275c671c5e33d95bb7e8d729,
        0x1a306d439d463b0816fc6fd64cc939318b45eb759ddde4aa106d15d9bd9baaaa
      )

      pRound(
        0x28a8f8372e3c38daced7c00421cb4621f4f1b54ddc27821b0d62d3d6ec7c56cf,
        0x0094975717f9a8a8bb35152f24d43294071ce320c829f388bc852183e1e2ce7e,
        0x04d5ee4c3aa78f7d80fde60d716480d3593f74d4f653ae83f4103246db2e8d65,
        0x2a6cf5e9aa03d4336349ad6fb8ed2269c7bef54b8822cc76d08495c12efde187
      )

      pRound(
        0x2304d31eaab960ba9274da43e19ddeb7f792180808fd6e43baae48d7efcba3f3,
        0x03fd9ac865a4b2a6d5e7009785817249bff08a7e0726fcb4e1c11d39d199f0b0,
        0x00b7258ded52bbda2248404d55ee5044798afc3a209193073f7954d4d63b0b64,
        0x159f81ada0771799ec38fca2d4bf65ebb13d3a74f3298db36272c5ca65e92d9a
      )

      pRound(
        0x1ef90e67437fbc8550237a75bc28e3bb9000130ea25f0c5471e144cf4264431f,
        0x1e65f838515e5ff0196b49aa41a2d2568df739bc176b08ec95a79ed82932e30d,
        0x2b1b045def3a166cec6ce768d079ba74b18c844e570e1f826575c1068c94c33f,
        0x0832e5753ceb0ff6402543b1109229c165dc2d73bef715e3f1c6e07c168bb173
      )

      pRound(
        0x02f614e9cedfb3dc6b762ae0a37d41bab1b841c2e8b6451bc5a8e3c390b6ad16,
        0x0e2427d38bd46a60dd640b8e362cad967370ebb777bedff40f6a0be27e7ed705,
        0x0493630b7c670b6deb7c84d414e7ce79049f0ec098c3c7c50768bbe29214a53a,
        0x22ead100e8e482674decdab17066c5a26bb1515355d5461a3dc06cc85327cea9
      )

      pRound(
        0x25b3e56e655b42cdaae2626ed2554d48583f1ae35626d04de5084e0b6d2a6f16,
        0x1e32752ada8836ef5837a6cde8ff13dbb599c336349e4c584b4fdc0a0cf6f9d0,
        0x2fa2a871c15a387cc50f68f6f3c3455b23c00995f05078f672a9864074d412e5,
        0x2f569b8a9a4424c9278e1db7311e889f54ccbf10661bab7fcd18e7c7a7d83505
      )

      pRound(
        0x044cb455110a8fdd531ade530234c518a7df93f7332ffd2144165374b246b43d,
        0x227808de93906d5d420246157f2e42b191fe8c90adfe118178ddc723a5319025,
        0x02fcca2934e046bc623adead873579865d03781ae090ad4a8579d2e7a6800355,
        0x0ef915f0ac120b876abccceb344a1d36bad3f3c5ab91a8ddcbec2e060d8befac
      )

      pRound(
        0x1797130f4b7a3e1777eb757bc6f287f6ab0fb85f6be63b09f3b16ef2b1405d38,
        0x0a76225dc04170ae3306c85abab59e608c7f497c20156d4d36c668555decc6e5,
        0x1fffb9ec1992d66ba1e77a7b93209af6f8fa76d48acb664796174b5326a31a5c,
        0x25721c4fc15a3f2853b57c338fa538d85f8fbba6c6b9c6090611889b797b9c5f
      )

      pRound(
        0x0c817fd42d5f7a41215e3d07ba197216adb4c3790705da95eb63b982bfcaf75a,
        0x13abe3f5239915d39f7e13c2c24970b6df8cf86ce00a22002bc15866e52b5a96,
        0x2106feea546224ea12ef7f39987a46c85c1bc3dc29bdbd7a92cd60acb4d391ce,
        0x21ca859468a746b6aaa79474a37dab49f1ca5a28c748bc7157e1b3345bb0f959
      )

      pRound(
        0x05ccd6255c1e6f0c5cf1f0df934194c62911d14d0321662a8f1a48999e34185b,
        0x0f0e34a64b70a626e464d846674c4c8816c4fb267fe44fe6ea28678cb09490a4,
        0x0558531a4e25470c6157794ca36d0e9647dbfcfe350d64838f5b1a8a2de0d4bf,
        0x09d3dca9173ed2faceea125157683d18924cadad3f655a60b72f5864961f1455
      )

      pRound(
        0x0328cbd54e8c0913493f866ed03d218bf23f92d68aaec48617d4c722e5bd4335,
        0x2bf07216e2aff0a223a487b1a7094e07e79e7bcc9798c648ee3347dd5329d34b,
        0x1daf345a58006b736499c583cb76c316d6f78ed6a6dffc82111e11a63fe412df,
        0x176563472456aaa746b694c60e1823611ef39039b2edc7ff391e6f2293d2c404
      )

      pRound(
        0x2ef1e0fad9f08e87a3bb5e47d7e33538ca964d2b7d1083d4fb0225035bd3f8db,
        0x226c9b1af95babcf17b2b1f57c7310179c1803dec5ae8f0a1779ed36c817ae2a,
        0x14bce3549cc3db7428126b4c3a15ae0ff8148c89f13fb35d35734eb5d4ad0def,
        0x2debff156e276bb5742c3373f2635b48b8e923d301f372f8e550cfd4034212c7
      )

      pRound(
        0x2d4083cf5a87f5b6fc2395b22e356b6441afe1b6b29c47add7d0432d1d4760c7,
        0x0c225b7bcd04bf9c34b911262fdc9c1b91bf79a10c0184d89c317c53d7161c29,
        0x03152169d4f3d06ec33a79bfac91a02c99aa0200db66d5aa7b835265f9c9c8f3,
        0x0b61811a9210be78b05974587486d58bddc8f51bfdfebbb87afe8b7aa7d3199c
      )

      pRound(
        0x203e000cad298daaf7eba6a5c5921878b8ae48acf7048f16046d637a533b6f78,
        0x1a44bf0937c722d1376672b69f6c9655ba7ee386fda1112c0757143d1bfa9146,
        0x0376b4fae08cb03d3500afec1a1f56acb8e0fde75a2106d7002f59c5611d4daa,
        0x00780af2ca1cad6465a2171250fdfc32d6fc241d3214177f3d553ef363182185
      )

      pRound(
        0x10774d9ab80c25bdeb808bedfd72a8d9b75dbe18d5221c87e9d857079bdc31d5,
        0x10dc6e9c006ea38b04b1e03b4bd9490c0d03f98929ca1d7fb56821fd19d3b6e8,
        0x00544b8338791518b2c7645a50392798b21f75bb60e3596170067d00141cac16,
        0x222c01175718386f2e2e82eb122789e352e105a3b8fa852613bc534433ee428c
      )

      pRound(
        0x2840d045e9bc22b259cfb8811b1e0f45b77f7bdb7f7e2b46151a1430f608e3c5,
        0x062752f86eebe11a009c937e468c335b04554574c2990196508e01fa5860186b,
        0x06041bdac48205ac87adb87c20a478a71c9950c12a80bc0a55a8e83eaaf04746,
        0x04a533f236c422d1ff900a368949b0022c7a2ae092f308d82b1dcbbf51f5000d
      )

      pRound(
        0x13e31d7a67232fd811d6a955b3d4f25dfe066d1e7dc33df04bde50a2b2d05b2a,
        0x011c2683ae91eb4dfbc13d6357e8599a9279d1648ff2c95d2f79905bb13920f1,
        0x0b0d219346b8574525b1a270e0b4cba5d56c928e3e2c2bd0a1ecaed015aaf6ae,
        0x14abdec8db9c6dc970291ee638690209b65080781ef9fd13d84c7a726b5f1364
      )

      pRound(
        0x1a0b70b4b26fdc28fcd32aa3d266478801eb12202ef47ced988d0376610be106,
        0x278543721f96d1307b6943f9804e7fe56401deb2ef99c4d12704882e7278b607,
        0x16eb59494a9776cf57866214dbd1473f3f0738a325638d8ba36535e011d58259,
        0x2567a658a81ffb444f240088fa5524c69a9e53eeab6b7f8c41c3479dcf8c644a
      )

      pRound(
        0x29aa1d7c151e9ad0a7ab39f1abd9cf77ab78e0215a5715a6b882ade840bb13d8,
        0x15c091233e60efe0d4bbfce2b36415006a4f017f9a85388ce206b91f99f2c984,
        0x16bd7d22ff858e5e0882c2c999558d77e7673ad5f1915f9feb679a8115f014cf,
        0x02db50480a07be0eb2c2e13ed6ef4074c0182d9b668b8e08ffe6769250042025
      )

      pRound(
        0x05e4a220e6a3bc9f7b6806ec9d6cdba186330ef2bf7adb4c13ba866343b73119,
        0x1dda05ebc30170bc98cbf2a5ee3b50e8b5f70bc424d39fa4104d37f1cbcf7a42,
        0x0184bef721888187f645b6fee3667f3c91da214414d89ba5cd301f22b0de8990,
        0x1498a307e68900065f5e8276f62aef1c37414b84494e1577ad1a6d64341b78ec
      )

      pRound(
        0x25f40f82b31dacc4f4939800b9d2c3eacef737b8fab1f864fe33548ad46bd49d,
        0x09d317cc670251943f6f5862a30d2ea9e83056ce4907bfbbcb1ff31ce5bb9650,
        0x2f77d77786d979b23ba4ce4a4c1b3bd0a41132cd467a86ab29b913b6cf3149d0,
        0x0f53dafd535a9f4473dc266b6fccc6841bbd336963f254c152f89e785f729bbf
      )

      pRound(
        0x25c1fd72e223045265c3a099e17526fa0e6976e1c00baf16de96de85deef2fa2,
        0x2a902c8980c17faae368d385d52d16be41af95c84eaea3cf893e65d6ce4a8f62,
        0x1ce1580a3452ecf302878c8976b82be96676dd114d1dc8d25527405762f83529,
        0x24a6073f91addc33a49a1fa306df008801c5ec569609034d2fc50f7f0f4d0056
      )

      pRound(
        0x25e52dbd6124530d9fc27fe306d71d4583e07ca554b5d1577f256c68b0be2b74,
        0x23dffae3c423fa7a93468dbccfb029855974be4d0a7b29946796e5b6cd70f15d,
        0x06342da370cc0d8c49b77594f6b027c480615d50be36243a99591bc9924ed6f5,
        0x2754114281286546b75f09f115fc751b4778303d0405c1b4cc7df0d8e9f63925
      )

      pRound(
        0x15c19e8534c5c1a8862c2bc1d119eddeabf214153833d7bdb59ee197f8187cf5,
        0x265fe062766d08fab4c78d0d9ef3cabe366f3be0a821061679b4b3d2d77d5f3e,
        0x13ccf689d67a3ec9f22cb7cd0ac3a327d377ac5cd0146f048debfd098d3ec7be,
        0x17662f7456789739f81cd3974827a887d92a5e05bdf3fe6b9fbccca4524aaebd
      )

      pRound(
        0x21b29c76329b31c8ef18631e515f7f2f82ca6a5cca70cee4e809fd624be7ad5d,
        0x18137478382aadba441eb97fe27901989c06738165215319939eb17b01fa975c,
        0x2bc07ea2bfad68e8dc724f5fef2b37c2d34f761935ffd3b739ceec4668f37e88,
        0x2ddb2e376f54d64a563840480df993feb4173203c2bd94ad0e602077aef9a03e
      )

      pRound(
        0x277eb50f2baa706106b41cb24c602609e8a20f8d72f613708adb25373596c3f7,
        0x0d4de47e1aba34269d0c620904f01a56b33fc4b450c0db50bb7f87734c9a1fe5,
        0x0b8442bfe9e4a1b4428673b6bd3eea6f9f445697058f134aae908d0279a29f0c,
        0x11fe5b18fbbea1a86e06930cb89f7d4a26e186a65945e96574247fddb720f8f5
      )

      pRound(
        0x224026f6dfaf71e24d25d8f6d9f90021df5b774dcad4d883170e4ad89c33a0d6,
        0x0b2ca6a999fe6887e0704dad58d03465a96bc9e37d1091f61bc9f9c62bbeb824,
        0x221b63d66f0b45f9d40c54053a28a06b1d0a4ce41d364797a1a7e0c96529f421,
        0x30185c48b7b2f1d53d4120801b047d087493bce64d4d24aedce2f4836bb84ad4
      )

      pRound(
        0x23f5d372a3f0e3cba989e223056227d3533356f0faa48f27f8267318632a61f0,
        0x2716683b32c755fd1bf8235ea162b1f388e1e0090d06162e8e6dfbe4328f3e3b,
        0x0977545836866fa204ca1d853ec0909e3d140770c80ac67dc930c69748d5d4bc,
        0x1444e8f592bdbfd8025d91ab4982dd425f51682d31472b05e81c43c0f9434b31
      )

      pRound(
        0x26e04b65e9ca8270beb74a1c5cb8fee8be3ffbfe583f7012a00f874e7718fbe3,
        0x22a5c2fa860d11fe34ee47a5cd9f869800f48f4febe29ad6df69816fb1a914d2,
        0x174b54d9907d8f5c6afd672a738f42737ec338f3a0964c629f7474dd44c5c8d7,
        0x1db1db8aa45283f31168fa66694cf2808d2189b87c8c8143d56c871907b39b87
      )

      pRound(
        0x1530bf0f46527e889030b8c7b7dfde126f65faf8cce0ab66387341d813d1bfd1,
        0x0b73f613993229f59f01c1cec8760e9936ead9edc8f2814889330a2f2bade457,
        0x29c25a22fe2164604552aaea377f448d587ab977fc8227787bd2dc0f36bcf41e,
        0x2b30d53ed1759bfb8503da66c92cf4077abe82795dc272b377df57d77c875526
      )

      pRound(
        0x12f6d703b5702aab7b7b7e69359d53a2756c08c85ede7227cf5f0a2916787cd2,
        0x2520e18300afda3f61a40a0b8837293a55ad01071028d4841ffa9ac706364113,
        0x1ec9daea860971ecdda8ed4f346fa967ac9bc59278277393c68f09fa03b8b95f,
        0x0a99b3e178db2e2e432f5cd5bef8fe4483bf5cbf70ed407c08aae24b830ad725
      )

      pRound(
        0x07cda9e63db6e39f086b89b601c2bbe407ee0abac3c817a1317abad7c5778492,
        0x08c9c65a4f955e8952d571b191bb0adb49bd8290963203b35d48aab38f8fc3a3,
        0x2737f8ce1d5a67b349590ddbfbd709ed9af54a2a3f2719d33801c9c17bdd9c9e,
        0x1049a6c65ff019f0d28770072798e8b7909432bd0c129813a9f179ba627f7d6a
      )

      pRound(
        0x18b4fe968732c462c0ea5a9beb27cecbde8868944fdf64ee60a5122361daeddb,
        0x2ff2b6fd22df49d2440b2eaeeefa8c02a6f478cfcf11f1b2a4f7473483885d19,
        0x2ec5f2f1928fe932e56c789b8f6bbcb3e8be4057cbd8dbd18a1b352f5cef42ff,
        0x265a5eccd8b92975e33ad9f75bf3426d424a4c6a7794ee3f08c1d100378e545e
      )

      pRound(
        0x2405eaa4c0bde1129d6242bb5ada0e68778e656cfcb366bf20517da1dfd4279c,
        0x094c97d8c194c42e88018004cbbf2bc5fdb51955d8b2d66b76dd98a2dbf60417,
        0x2c30d5f33bb32c5c22b9979a605bf64d508b705221e6a686330c9625c2afe0b8,
        0x01a75666f6241f6825d01cc6dcb1622d4886ea583e87299e6aa2fc716fdb6cf5
      )

      pRound(
        0x0a3290e8398113ea4d12ac091e87be7c6d359ab9a66979fcf47bf2e87d382fcb,
        0x154ade9ca36e268dfeb38461425bb0d8c31219d8fa0dfc75ecd21bf69aa0cc74,
        0x27aa8d3e25380c0b1b172d79c6f22eee99231ef5dc69d8dc13a4b5095d028772,
        0x2cf4051e6cab48301a8b2e3bca6099d756bbdf485afa1f549d395bbcbd806461
      )

      pRound(
        0x301e70f729f3c94b1d3f517ddff9f2015131feab8afa5eebb0843d7f84b23e71,
        0x298beb64f812d25d8b4d9620347ab02332dc4cef113ae60d17a8d7a4c91f83bc,
        0x1b362e72a5f847f84d03fd291c3c471ed1c14a15b221680acf11a3f02e46aa95,
        0x0dc8a2146110c0b375432902999223d5aa1ef6e78e1e5ebcbc1d9ba41dc1c737
      )

      pRound(
        0x0a48663b34ce5e1c05dc93092cb69778cb21729a72ddc03a08afa1eb922ff279,
        0x0a87391fb1cd8cdf6096b64a82f9e95f0fe46f143b702d74545bb314881098ee,
        0x1b5b2946f7c28975f0512ff8e6ca362f8826edd7ea9c29f382ba8a2a0892fd5d,
        0x01001cf512ac241d47ebe2239219bc6a173a8bbcb8a5b987b4eac1f533315b6b
      )

      pRound(
        0x2fd977c70f645db4f704fa7d7693da727ac093d3fb5f5febc72beb17d8358a32,
        0x23c0039a3fab4ad3c2d7cc688164f39e761d5355c05444d99be763a97793a9c4,
        0x19d43ee0c6081c052c9c0df6161eaac1aec356cf435888e79f27f22ff03fa25d,
        0x2d9b10c2f2e7ac1afddccffd94a563028bf29b646d020830919f9d5ca1cefe59
      )

      pRound(
        0x2457ca6c2f2aa30ec47e4aff5a66f5ce2799283e166fc81cdae2f2b9f83e4267,
        0x0abc392fe85eda855820592445094022811ee8676ed6f0c3044dfb54a7c10b35,
        0x19d2cc5ca549d1d40cebcd37f3ea54f31161ac3993acf3101d2c2bc30eac1eb0,
        0x0f97ae3033ffa01608aafb26ae13cd393ee0e4ec041ba644a3d3ab546e98c9c8
      )

      pRound(
        0x16dbc78fd28b7fb8260e404cf1d427a7fa15537ea4e168e88a166496e88cfeca,
        0x240faf28f11499b916f085f73bc4f22eef8344e576f8ad3d1827820366d5e07b,
        0x0a1bb075aa37ff0cfe6c8531e55e1770eaba808c8fdb6dbf46f8cab58d9ef1af,
        0x2e47e15ea4a47ff1a6a853aaf3a644ca38d5b085ac1042fdc4a705a7ce089f4d
      )

      pRound(
        0x166e5bf073378348860ca4a9c09d39e1673ab059935f4df35fb14528375772b6,
        0x18b42d7ffdd2ea4faf235902f057a2740cacccd027233001ed10f96538f0916f,
        0x089cb1b032238f5e4914788e3e3c7ead4fc368020b3ed38221deab1051c37702,
        0x242acd3eb3a2f72baf7c7076dd165adf89f9339c7b971921d9e70863451dd8d1
      )

      pRound(
        0x174fbb104a4ee302bf47f2bd82fce896eac9a068283f326474af860457245c3b,
        0x17340e71d96f466d61f3058ce092c67d2891fb2bb318613f780c275fe1116c6b,
        0x1e8e40ac853b7d42f00f2e383982d024f098b9f8fd455953a2fd380c4df7f6b2,
        0x0529898dc0649907e1d4d5e284b8d1075198c55cad66e8a9bf40f92938e2e961
      )

      pRound(
        0x2162754db0baa030bf7de5bb797364dce8c77aa017ee1d7bf65f21c4d4e5df8f,
        0x12c7553698c4bf6f3ceb250ae00c58c2a9f9291efbde4c8421bef44741752ec6,
        0x292643e3ba2026affcb8c5279313bd51a733c93353e9d9c79cb723136526508e,
        0x00ccf13e0cb6f9d81d52951bea990bd5b6c07c5d98e66ff71db6e74d5b87d158
      )

      pRound(
        0x185d1e20e23b0917dd654128cf2f3aaab6723873cb30fc22b0f86c15ab645b4b,
        0x14c61c836d55d3df742bdf11c60efa186778e3de0f024c0f13fe53f8d8764e1f,
        0x0f356841b3f556fce5dbe4680457691c2919e2af53008184d03ee1195d72449e,
        0x1b8fd9ff39714e075df124f887bf40b383143374fd2080ba0c0a6b6e8fa5b3e8
      )

      pRound(
        0x0e86a8c2009c140ca3f873924e2aaa14fc3c8ae04e9df0b3e9103418796f6024,
        0x2e6c5e898f5547770e5462ad932fcdd2373fc43820ca2b16b0861421e79155c8,
        0x05d797f1ab3647237c14f9d1df032bc9ff9fe1a0ecd377972ce5fd5a0c014604,
        0x29a3110463a5aae76c3d152875981d0c1daf2dcd65519ef5ca8929851da8c008
      )

      pRound(
        0x2974da7bc074322273c3a4b91c05354cdc71640a8bbd1f864b732f8163883314,
        0x1ed0fb06699ba249b2a30621c05eb12ca29cb91aa082c8bfcce9c522889b47dc,
        0x1c793ef0dcc51123654ff26d8d863feeae29e8c572eca912d80c8ae36e40fe9b,
        0x1e6aac1c6d3dd3157956257d3d234ef18c91e82589a78169fbb4a8770977dc2f
      )

      pRound(
        0x1a20ada7576234eee6273dd6fa98b25ed037748080a47d948fcda33256fb6bf5,
        0x191033d6d85ceaa6fc7a9a23a6fd9996642d772045ece51335d49306728af96c,
        0x006e5979da7e7ef53a825aa6fddc3abfc76f200b3740b8b232ef481f5d06297b,
        0x0b0d7e69c651910bbef3e68d417e9fa0fbd57f596c8f29831eff8c0174cdb06d
      )

      pRound(
        0x25caf5b0c1b93bc516435ec084e2ecd44ac46dbbb033c5112c4b20a25c9cdf9d,
        0x12c1ea892cc31e0d9af8b796d9645872f7f77442d62fd4c8085b2f150f72472a,
        0x16af29695157aba9b8bbe3afeb245feee5a929d9f928b9b81de6dadc78c32aae,
        0x0136df457c80588dd687fb2f3be18691705b87ec5a4cfdc168d31084256b67dc
      )

      pRound(
        0x1639a28c5b4c81166aea984fba6e71479e07b1efbc74434db95a285060e7b089,
        0x03d62fbf82fd1d4313f8e650f587ec06816c28b700bdc50f7e232bd9b5ca9b76,
        0x11aeeb527dc8ce44b4d14aaddca3cfe2f77a1e40fc6da97c249830de1edfde54,
        0x13f9b9a41274129479c5e6138c6c8ee36a670e6bc68c7a49642b645807bfc824
      )

      fRound(
        0x0e4772fa3d75179dc8484cd26c7c1f635ddeeed7a939440c506cae8b7ebcd15b,
        0x1b39a00cbc81e427de4bdec58febe8d8b5971752067a612b39fc46a68c5d4db4,
        0x2bedb66e1ad5a1d571e16e2953f48731f66463c2eb54a245444d1c0a3a25707e,
        0x2cf0a09a55ca93af8abd068f06a7287fb08b193b608582a27379ce35da915dec
      )

      fRound(
        0x2d1bd78fa90e77aa88830cabfef2f8d27d1a512050ba7db0753c8fb863efb387,
        0x065610c6f4f92491f423d3071eb83539f7c0d49c1387062e630d7fd283dc3394,
        0x2d933ff19217a5545013b12873452bebcc5f9969033f15ec642fb464bd607368,
        0x1aa9d3fe4c644910f76b92b3e13b30d500dae5354e79508c3c49c8aa99e0258b
      )

      fRound(
        0x027ef04869e482b1c748638c59111c6b27095fa773e1aca078cea1f1c8450bdd,
        0x2b7d524c5172cbbb15db4e00668a8c449f67a2605d9ec03802e3fa136ad0b8fb,
        0x0c7c382443c6aa787c8718d86747c7f74693ae25b1e55df13f7c3c1dd735db0f,
        0x00b4567186bc3f7c62a7b56acf4f76207a1f43c2d30d0fe4a627dcdd9bd79078
      )

      {
        let state0 := add(mload(0x0), 0x1e41fc29b825454fe6d61737fe08b47fb07fe739e4c1e61d0337490883db4fd5)
        let state1 := add(mload(0x20), 0x12507cd556b7bbcc72ee6dafc616584421e1af872d8c0e89002ae8d3ba0653b6)
        let state2 := add(mload(0x80), 0x13d437083553006bcef312e5e6f52a5d97eb36617ef36fe4d77d3e97f71cb5db)
        let state3 := add(mload(0xa0), 0x163ec73251f85443687222487dda9a65467d90b22f0b38664686077c6a4486d5)

        p := mulmod(state0, state0, F)
        state0 := mulmod(mulmod(p, p, F), state0, F)
        p := mulmod(state1, state1, F)
        state1 := mulmod(mulmod(p, p, F), state1, F)
        p := mulmod(state2, state2, F)
        state2 := mulmod(mulmod(p, p, F), state2, F)
        p := mulmod(state3, state3, F)
        state3 := mulmod(mulmod(p, p, F), state3, F)

        mstore(0x0, mod(mod(add(add(add(mulmod(state0, M00, F), mulmod(state1, M10, F)), mulmod(state2, M20, F)), mulmod(state3, M30, F)), F), F))
        return(0, 0x20)
      }
    }
  }
}

// lib/openzeppelin-contracts/contracts/utils/StorageSlot.sol

// OpenZeppelin Contracts (last updated v5.1.0) (utils/StorageSlot.sol)
// This file was procedurally generated from scripts/generate/templates/StorageSlot.js.

/**
 * @dev Library for reading and writing primitive types to specific storage slots.
 *
 * Storage slots are often used to avoid storage conflict when dealing with upgradeable contracts.
 * This library helps with reading and writing to such slots without the need for inline assembly.
 *
 * The functions in this library return Slot structs that contain a `value` member that can be used to read or write.
 *
 * Example usage to set ERC-1967 implementation slot:
 * ```solidity
 * contract ERC1967 {
 *     // Define the slot. Alternatively, use the SlotDerivation library to derive the slot.
 *     bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
 *
 *     function _getImplementation() internal view returns (address) {
 *         return StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value;
 *     }
 *
 *     function _setImplementation(address newImplementation) internal {
 *         require(newImplementation.code.length > 0);
 *         StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value = newImplementation;
 *     }
 * }
 * ```
 *
 * TIP: Consider using this library along with {SlotDerivation}.
 */
library StorageSlot {
    struct AddressSlot {
        address value;
    }

    struct BooleanSlot {
        bool value;
    }

    struct Bytes32Slot {
        bytes32 value;
    }

    struct Uint256Slot {
        uint256 value;
    }

    struct Int256Slot {
        int256 value;
    }

    struct StringSlot {
        string value;
    }

    struct BytesSlot {
        bytes value;
    }

    /**
     * @dev Returns an `AddressSlot` with member `value` located at `slot`.
     */
    function getAddressSlot(bytes32 slot) internal pure returns (AddressSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `BooleanSlot` with member `value` located at `slot`.
     */
    function getBooleanSlot(bytes32 slot) internal pure returns (BooleanSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Bytes32Slot` with member `value` located at `slot`.
     */
    function getBytes32Slot(bytes32 slot) internal pure returns (Bytes32Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Uint256Slot` with member `value` located at `slot`.
     */
    function getUint256Slot(bytes32 slot) internal pure returns (Uint256Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Int256Slot` with member `value` located at `slot`.
     */
    function getInt256Slot(bytes32 slot) internal pure returns (Int256Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `StringSlot` with member `value` located at `slot`.
     */
    function getStringSlot(bytes32 slot) internal pure returns (StringSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns an `StringSlot` representation of the string storage pointer `store`.
     */
    function getStringSlot(string storage store) internal pure returns (StringSlot storage r) {
        assembly ("memory-safe") {
            r.slot := store.slot
        }
    }

    /**
     * @dev Returns a `BytesSlot` with member `value` located at `slot`.
     */
    function getBytesSlot(bytes32 slot) internal pure returns (BytesSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns an `BytesSlot` representation of the bytes storage pointer `store`.
     */
    function getBytesSlot(bytes storage store) internal pure returns (BytesSlot storage r) {
        assembly ("memory-safe") {
            r.slot := store.slot
        }
    }
}

// lib/openzeppelin-contracts/contracts/interfaces/draft-IERC1822.sol

// OpenZeppelin Contracts (last updated v5.1.0) (interfaces/draft-IERC1822.sol)

/**
 * @dev ERC-1822: Universal Upgradeable Proxy Standard (UUPS) documents a method for upgradeability through a simplified
 * proxy whose upgrades are fully controlled by the current implementation.
 */
interface IERC1822Proxiable {
    /**
     * @dev Returns the storage slot that the proxiable contract assumes is being used to store the implementation
     * address.
     *
     * IMPORTANT: A proxy pointing at a proxiable contract should not be considered proxiable itself, because this risks
     * bricking a proxy that upgrades to it, by delegating to itself until out of gas. Thus it is critical that this
     * function revert if invoked through a proxy.
     */
    function proxiableUUID() external view returns (bytes32);
}

// lib/openzeppelin-contracts/contracts/utils/Address.sol

// OpenZeppelin Contracts (last updated v5.1.0) (utils/Address.sol)

/**
 * @dev Collection of functions related to the address type
 */
library Address {
    /**
     * @dev There's no code at `target` (it is not a contract).
     */
    error AddressEmptyCode(address target);

    /**
     * @dev Replacement for Solidity's `transfer`: sends `amount` wei to
     * `recipient`, forwarding all available gas and reverting on errors.
     *
     * https://eips.ethereum.org/EIPS/eip-1884[EIP1884] increases the gas cost
     * of certain opcodes, possibly making contracts go over the 2300 gas limit
     * imposed by `transfer`, making them unable to receive funds via
     * `transfer`. {sendValue} removes this limitation.
     *
     * https://consensys.net/diligence/blog/2019/09/stop-using-soliditys-transfer-now/[Learn more].
     *
     * IMPORTANT: because control is transferred to `recipient`, care must be
     * taken to not create reentrancy vulnerabilities. Consider using
     * {ReentrancyGuard} or the
     * https://solidity.readthedocs.io/en/v0.8.20/security-considerations.html#use-the-checks-effects-interactions-pattern[checks-effects-interactions pattern].
     */
    function sendValue(address payable recipient, uint256 amount) internal {
        if (address(this).balance < amount) {
            revert Errors.InsufficientBalance(address(this).balance, amount);
        }

        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert Errors.FailedCall();
        }
    }

    /**
     * @dev Performs a Solidity function call using a low level `call`. A
     * plain `call` is an unsafe replacement for a function call: use this
     * function instead.
     *
     * If `target` reverts with a revert reason or custom error, it is bubbled
     * up by this function (like regular Solidity function calls). However, if
     * the call reverted with no returned reason, this function reverts with a
     * {Errors.FailedCall} error.
     *
     * Returns the raw returned data. To convert to the expected return value,
     * use https://solidity.readthedocs.io/en/latest/units-and-global-variables.html?highlight=abi.decode#abi-encoding-and-decoding-functions[`abi.decode`].
     *
     * Requirements:
     *
     * - `target` must be a contract.
     * - calling `target` with `data` must not revert.
     */
    function functionCall(address target, bytes memory data) internal returns (bytes memory) {
        return functionCallWithValue(target, data, 0);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but also transferring `value` wei to `target`.
     *
     * Requirements:
     *
     * - the calling contract must have an ETH balance of at least `value`.
     * - the called Solidity function must be `payable`.
     */
    function functionCallWithValue(address target, bytes memory data, uint256 value) internal returns (bytes memory) {
        if (address(this).balance < value) {
            revert Errors.InsufficientBalance(address(this).balance, value);
        }
        (bool success, bytes memory returndata) = target.call{value: value}(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but performing a static call.
     */
    function functionStaticCall(address target, bytes memory data) internal view returns (bytes memory) {
        (bool success, bytes memory returndata) = target.staticcall(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but performing a delegate call.
     */
    function functionDelegateCall(address target, bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory returndata) = target.delegatecall(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Tool to verify that a low level call to smart-contract was successful, and reverts if the target
     * was not a contract or bubbling up the revert reason (falling back to {Errors.FailedCall}) in case
     * of an unsuccessful call.
     */
    function verifyCallResultFromTarget(
        address target,
        bool success,
        bytes memory returndata
    ) internal view returns (bytes memory) {
        if (!success) {
            _revert(returndata);
        } else {
            // only check if target is a contract if the call was successful and the return data is empty
            // otherwise we already know that it was a contract
            if (returndata.length == 0 && target.code.length == 0) {
                revert AddressEmptyCode(target);
            }
            return returndata;
        }
    }

    /**
     * @dev Tool to verify that a low level call was successful, and reverts if it wasn't, either by bubbling the
     * revert reason or with a default {Errors.FailedCall} error.
     */
    function verifyCallResult(bool success, bytes memory returndata) internal pure returns (bytes memory) {
        if (!success) {
            _revert(returndata);
        } else {
            return returndata;
        }
    }

    /**
     * @dev Reverts with returndata if present. Otherwise reverts with {Errors.FailedCall}.
     */
    function _revert(bytes memory returndata) private pure {
        // Look for revert reason and bubble it up if present
        if (returndata.length > 0) {
            // The easiest way to bubble the revert reason is using memory via assembly
            assembly ("memory-safe") {
                let returndata_size := mload(returndata)
                revert(add(32, returndata), returndata_size)
            }
        } else {
            revert Errors.FailedCall();
        }
    }
}

// lib/openzeppelin-contracts-upgradeable/contracts/utils/ContextUpgradeable.sol

// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract ContextUpgradeable is Initializable {
    function __Context_init() internal onlyInitializing {
    }

    function __Context_init_unchained() internal onlyInitializing {
    }
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}

// lib/openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract OwnableUpgradeable is Initializable, ContextUpgradeable {
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorage {
        address _owner;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Ownable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OwnableStorageLocation = 0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300;

    function _getOwnableStorage() private pure returns (OwnableStorage storage $) {
        assembly {
            $.slot := OwnableStorageLocation
        }
    }

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    function __Ownable_init(address initialOwner) internal onlyInitializing {
        __Ownable_init_unchained(initialOwner);
    }

    function __Ownable_init_unchained(address initialOwner) internal onlyInitializing {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {
        OwnableStorage storage $ = _getOwnableStorage();
        return $._owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {
        OwnableStorage storage $ = _getOwnableStorage();
        address oldOwner = $._owner;
        $._owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

// lib/openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol

// OpenZeppelin Contracts (last updated v5.1.0) (access/Ownable2Step.sol)

/**
 * @dev Contract module which provides access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * This extension of the {Ownable} contract includes a two-step mechanism to transfer
 * ownership, where the new owner must call {acceptOwnership} in order to replace the
 * old one. This can help prevent common mistakes, such as transfers of ownership to
 * incorrect accounts, or to contracts that are unable to interact with the
 * permission system.
 *
 * The initial owner is specified at deployment time in the constructor for `Ownable`. This
 * can later be changed with {transferOwnership} and {acceptOwnership}.
 *
 * This module is used through inheritance. It will make available all functions
 * from parent (Ownable).
 */
abstract contract Ownable2StepUpgradeable is Initializable, OwnableUpgradeable {
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable2Step
    struct Ownable2StepStorage {
        address _pendingOwner;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Ownable2Step")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant Ownable2StepStorageLocation = 0x237e158222e3e6968b72b9db0d8043aacf074ad9f650f0d1606b4d82ee432c00;

    function _getOwnable2StepStorage() private pure returns (Ownable2StepStorage storage $) {
        assembly {
            $.slot := Ownable2StepStorageLocation
        }
    }

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function __Ownable2Step_init() internal onlyInitializing {
    }

    function __Ownable2Step_init_unchained() internal onlyInitializing {
    }
    /**
     * @dev Returns the address of the pending owner.
     */
    function pendingOwner() public view virtual returns (address) {
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();
        return $._pendingOwner;
    }

    /**
     * @dev Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     *
     * Setting `newOwner` to the zero address is allowed; this can be used to cancel an initiated ownership transfer.
     */
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();
        $._pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual override {
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();
        delete $._pendingOwner;
        super._transferOwnership(newOwner);
    }

    /**
     * @dev The new owner accepts the ownership transfer.
     */
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}

// lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Utils.sol

// OpenZeppelin Contracts (last updated v5.1.0) (proxy/ERC1967/ERC1967Utils.sol)

/**
 * @dev This library provides getters and event emitting update functions for
 * https://eips.ethereum.org/EIPS/eip-1967[ERC-1967] slots.
 */
library ERC1967Utils {
    /**
     * @dev Storage slot with the address of the current implementation.
     * This is the keccak-256 hash of "eip1967.proxy.implementation" subtracted by 1.
     */
    // solhint-disable-next-line private-vars-leading-underscore
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /**
     * @dev The `implementation` of the proxy is invalid.
     */
    error ERC1967InvalidImplementation(address implementation);

    /**
     * @dev The `admin` of the proxy is invalid.
     */
    error ERC1967InvalidAdmin(address admin);

    /**
     * @dev The `beacon` of the proxy is invalid.
     */
    error ERC1967InvalidBeacon(address beacon);

    /**
     * @dev An upgrade function sees `msg.value > 0` that may be lost.
     */
    error ERC1967NonPayable();

    /**
     * @dev Returns the current implementation address.
     */
    function getImplementation() internal view returns (address) {
        return StorageSlot.getAddressSlot(IMPLEMENTATION_SLOT).value;
    }

    /**
     * @dev Stores a new address in the ERC-1967 implementation slot.
     */
    function _setImplementation(address newImplementation) private {
        if (newImplementation.code.length == 0) {
            revert ERC1967InvalidImplementation(newImplementation);
        }
        StorageSlot.getAddressSlot(IMPLEMENTATION_SLOT).value = newImplementation;
    }

    /**
     * @dev Performs implementation upgrade with additional setup call if data is nonempty.
     * This function is payable only if the setup call is performed, otherwise `msg.value` is rejected
     * to avoid stuck value in the contract.
     *
     * Emits an {IERC1967-Upgraded} event.
     */
    function upgradeToAndCall(address newImplementation, bytes memory data) internal {
        _setImplementation(newImplementation);
        emit IERC1967.Upgraded(newImplementation);

        if (data.length > 0) {
            Address.functionDelegateCall(newImplementation, data);
        } else {
            _checkNonPayable();
        }
    }

    /**
     * @dev Storage slot with the admin of the contract.
     * This is the keccak-256 hash of "eip1967.proxy.admin" subtracted by 1.
     */
    // solhint-disable-next-line private-vars-leading-underscore
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    /**
     * @dev Returns the current admin.
     *
     * TIP: To get this value clients can read directly from the storage slot shown below (specified by ERC-1967) using
     * the https://eth.wiki/json-rpc/API#eth_getstorageat[`eth_getStorageAt`] RPC call.
     * `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`
     */
    function getAdmin() internal view returns (address) {
        return StorageSlot.getAddressSlot(ADMIN_SLOT).value;
    }

    /**
     * @dev Stores a new address in the ERC-1967 admin slot.
     */
    function _setAdmin(address newAdmin) private {
        if (newAdmin == address(0)) {
            revert ERC1967InvalidAdmin(address(0));
        }
        StorageSlot.getAddressSlot(ADMIN_SLOT).value = newAdmin;
    }

    /**
     * @dev Changes the admin of the proxy.
     *
     * Emits an {IERC1967-AdminChanged} event.
     */
    function changeAdmin(address newAdmin) internal {
        emit IERC1967.AdminChanged(getAdmin(), newAdmin);
        _setAdmin(newAdmin);
    }

    /**
     * @dev The storage slot of the UpgradeableBeacon contract which defines the implementation for this proxy.
     * This is the keccak-256 hash of "eip1967.proxy.beacon" subtracted by 1.
     */
    // solhint-disable-next-line private-vars-leading-underscore
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    /**
     * @dev Returns the current beacon.
     */
    function getBeacon() internal view returns (address) {
        return StorageSlot.getAddressSlot(BEACON_SLOT).value;
    }

    /**
     * @dev Stores a new beacon in the ERC-1967 beacon slot.
     */
    function _setBeacon(address newBeacon) private {
        if (newBeacon.code.length == 0) {
            revert ERC1967InvalidBeacon(newBeacon);
        }

        StorageSlot.getAddressSlot(BEACON_SLOT).value = newBeacon;

        address beaconImplementation = IBeacon(newBeacon).implementation();
        if (beaconImplementation.code.length == 0) {
            revert ERC1967InvalidImplementation(beaconImplementation);
        }
    }

    /**
     * @dev Change the beacon and trigger a setup call if data is nonempty.
     * This function is payable only if the setup call is performed, otherwise `msg.value` is rejected
     * to avoid stuck value in the contract.
     *
     * Emits an {IERC1967-BeaconUpgraded} event.
     *
     * CAUTION: Invoking this function has no effect on an instance of {BeaconProxy} since v5, since
     * it uses an immutable beacon without looking at the value of the ERC-1967 beacon slot for
     * efficiency.
     */
    function upgradeBeaconToAndCall(address newBeacon, bytes memory data) internal {
        _setBeacon(newBeacon);
        emit IERC1967.BeaconUpgraded(newBeacon);

        if (data.length > 0) {
            Address.functionDelegateCall(IBeacon(newBeacon).implementation(), data);
        } else {
            _checkNonPayable();
        }
    }

    /**
     * @dev Reverts if `msg.value` is not zero. It can be used to avoid `msg.value` stuck in the contract
     * if an upgrade doesn't perform an initialization call.
     */
    function _checkNonPayable() private {
        if (msg.value > 0) {
            revert ERC1967NonPayable();
        }
    }
}

// lib/openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol

// OpenZeppelin Contracts (last updated v5.1.0) (proxy/utils/UUPSUpgradeable.sol)

/**
 * @dev An upgradeability mechanism designed for UUPS proxies. The functions included here can perform an upgrade of an
 * {ERC1967Proxy}, when this contract is set as the implementation behind such a proxy.
 *
 * A security mechanism ensures that an upgrade does not turn off upgradeability accidentally, although this risk is
 * reinstated if the upgrade retains upgradeability but removes the security mechanism, e.g. by replacing
 * `UUPSUpgradeable` with a custom implementation of upgrades.
 *
 * The {_authorizeUpgrade} function must be overridden to include access restriction to the upgrade mechanism.
 */
abstract contract UUPSUpgradeable is Initializable, IERC1822Proxiable {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable __self = address(this);

    /**
     * @dev The version of the upgrade interface of the contract. If this getter is missing, both `upgradeTo(address)`
     * and `upgradeToAndCall(address,bytes)` are present, and `upgradeTo` must be used if no function should be called,
     * while `upgradeToAndCall` will invoke the `receive` function if the second argument is the empty byte string.
     * If the getter returns `"5.0.0"`, only `upgradeToAndCall(address,bytes)` is present, and the second argument must
     * be the empty byte string if no function should be called, making it impossible to invoke the `receive` function
     * during an upgrade.
     */
    string public constant UPGRADE_INTERFACE_VERSION = "5.0.0";

    /**
     * @dev The call is from an unauthorized context.
     */
    error UUPSUnauthorizedCallContext();

    /**
     * @dev The storage `slot` is unsupported as a UUID.
     */
    error UUPSUnsupportedProxiableUUID(bytes32 slot);

    /**
     * @dev Check that the execution is being performed through a delegatecall call and that the execution context is
     * a proxy contract with an implementation (as defined in ERC-1967) pointing to self. This should only be the case
     * for UUPS and transparent proxies that are using the current contract as their implementation. Execution of a
     * function through ERC-1167 minimal proxies (clones) would not normally pass this test, but is not guaranteed to
     * fail.
     */
    modifier onlyProxy() {
        _checkProxy();
        _;
    }

    /**
     * @dev Check that the execution is not being performed through a delegate call. This allows a function to be
     * callable on the implementing contract but not through proxies.
     */
    modifier notDelegated() {
        _checkNotDelegated();
        _;
    }

    function __UUPSUpgradeable_init() internal onlyInitializing {
    }

    function __UUPSUpgradeable_init_unchained() internal onlyInitializing {
    }
    /**
     * @dev Implementation of the ERC-1822 {proxiableUUID} function. This returns the storage slot used by the
     * implementation. It is used to validate the implementation's compatibility when performing an upgrade.
     *
     * IMPORTANT: A proxy pointing at a proxiable contract should not be considered proxiable itself, because this risks
     * bricking a proxy that upgrades to it, by delegating to itself until out of gas. Thus it is critical that this
     * function revert if invoked through a proxy. This is guaranteed by the `notDelegated` modifier.
     */
    function proxiableUUID() external view virtual notDelegated returns (bytes32) {
        return ERC1967Utils.IMPLEMENTATION_SLOT;
    }

    /**
     * @dev Upgrade the implementation of the proxy to `newImplementation`, and subsequently execute the function call
     * encoded in `data`.
     *
     * Calls {_authorizeUpgrade}.
     *
     * Emits an {Upgraded} event.
     *
     * @custom:oz-upgrades-unsafe-allow-reachable delegatecall
     */
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        _upgradeToAndCallUUPS(newImplementation, data);
    }

    /**
     * @dev Reverts if the execution is not performed via delegatecall or the execution
     * context is not of a proxy with an ERC-1967 compliant implementation pointing to self.
     * See {_onlyProxy}.
     */
    function _checkProxy() internal view virtual {
        if (
            address(this) == __self || // Must be called through delegatecall
            ERC1967Utils.getImplementation() != __self // Must be called through an active proxy
        ) {
            revert UUPSUnauthorizedCallContext();
        }
    }

    /**
     * @dev Reverts if the execution is performed via delegatecall.
     * See {notDelegated}.
     */
    function _checkNotDelegated() internal view virtual {
        if (address(this) != __self) {
            // Must not be called through delegatecall
            revert UUPSUnauthorizedCallContext();
        }
    }

    /**
     * @dev Function that should revert when `msg.sender` is not authorized to upgrade the contract. Called by
     * {upgradeToAndCall}.
     *
     * Normally, this function will use an xref:access.adoc[access control] modifier such as {Ownable-onlyOwner}.
     *
     * ```solidity
     * function _authorizeUpgrade(address) internal onlyOwner {}
     * ```
     */
    function _authorizeUpgrade(address newImplementation) internal virtual;

    /**
     * @dev Performs an implementation upgrade with a security check for UUPS proxies, and additional setup call.
     *
     * As a security check, {proxiableUUID} is invoked in the new implementation, and the return value
     * is expected to be the implementation slot in ERC-1967.
     *
     * Emits an {IERC1967-Upgraded} event.
     */
    function _upgradeToAndCallUUPS(address newImplementation, bytes memory data) private {
        try IERC1822Proxiable(newImplementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT) {
                revert UUPSUnsupportedProxiableUUID(slot);
            }
            ERC1967Utils.upgradeToAndCall(newImplementation, data);
        } catch {
            // The implementation is not UUPS
            revert ERC1967Utils.ERC1967InvalidImplementation(newImplementation);
        }
    }
}

// src/DelegationRegistry.sol

interface IVetIssuerVetOwner {
    function vetOwner() external view returns (address);
}

interface IFactoryIsClone {
    function isClone(address account) external view returns (bool);
}

interface IEntityRegistryIsActive {
    function isActive(address account) external view returns (bool);
}

/// @title DelegationRegistry - per-`dogTagId` secondary-owner (delegate) set and its Merkle root.
///
/// @notice Holds the delegation model `docs/DELEGATION.md` section 4.2 describes: a small, capped set of
/// delegate key commitments per tag, individually revocable by any currently-Active clinic (Kenneth's
/// decision, `plans/wp4.15-multi-owner.md` section 9 item 2 - not scoped to the tag's original issuer),
/// folded into a single on-chain `delegationRoot` the future delegate consent circuit (section 4.4) will
/// take as a public input. This contract never touches `R`/`profileRoot` and never learns a delegate's
/// wallet address - only their opaque BabyJubJub key commitment (section 4.2) - so it cannot affect, and
/// is not affected by, the primary owner's `P-e` invariant (`docs/DELEGATION.md` section 5).
///
/// @dev UUPS upgradeable, `Ownable2StepUpgradeable`-controlled by the protocol admin - the same shape as
/// `EntityRegistry`/`VetIssuerFactory` (plan section 11.2 item B1: "admin-owned like the tag contract").
/// `factory`/`entityRegistry` are `immutable`: baked into this SINGLETON contract's implementation
/// bytecode at construction, exactly like `VerificationRegistryConsent`'s own `rootIndex`/`entityRegistry`
/// - see that contract's doc for why an immutable trust anchor is the deliberate choice here too
/// (replacing either dependency means redeploying this registry, not repointing it).
///
/// # The 16-slot tree and its fold (plan section 13 settlement)
///
/// Every `dogTagId` gets its own fixed-width, depth-4 tree: exactly 16 leaf slots, each holding either a
/// delegate's commitment or the all-zero value for an empty/revoked slot (never removed or compacted -
/// {revoke} zeroes a slot IN PLACE). `delegationRoot` is this codebase's own `buildMerkle` convention
/// (`packages/dogtag-standard-ts/src/merkle.ts`) applied to those 16 values: sort them ascending as field
/// elements, then fold bottom-up with the commutative, domain-separated pair hash every other Merkle root
/// in this protocol already uses, `hashNode(a, b) = Poseidon3(DS_NODE=2, min(a,b), max(a,b))`
/// (`poseidon-solidity` calls a 3-input Poseidon call "PoseidonT4" - state width, not input count).
/// Sixteen is a fixed power of two, so depth is fixed and no odd-node promotion ever applies. Because the
/// fold sorts the full 16-value list before pairing, `delegationRoot` depends only on the CURRENT
/// multiset of 16 slot values, never on which physical slot holds which commitment - cross-checked
/// against `packages/dogtag-standard-ts/src/merkle.ts`'s real `buildMerkle`/`hashNode` byte-for-byte in
/// `test/DelegationRegistry.t.sol`.
///
/// # Emptiness is a count, never a root comparison
///
/// Folding sixteen zero leaves is a specific, non-zero value - {EMPTY_DELEGATION_ROOT} - not `0`. This
/// contract's {delegationRoot} accessor returns that named constant whenever {secondaryCount} is zero
/// (untouched tag, or every member since revoked - the two cases fold to the identical all-zero leaf set
/// and so are indistinguishable by root alone), and the real incrementally-maintained fold otherwise. A
/// future consumer MUST test emptiness with {secondaryCount} `== 0`, never by comparing a root against
/// `0` or against {EMPTY_DELEGATION_ROOT} (`docs/DELEGATION.md` section 4.2).
///
/// # What this contract deliberately does NOT check
///
/// {add}/{revoke} do not consult the SBT's tag-lifecycle status (`Deceased`/`Revoked` are terminal) or
/// whether `dogTagId` was ever actually issued anywhere - `docs/DELEGATION.md` section 4.6 leaves this an
/// open WP4.15B implementation choice ("either choice is safe"), because a terminal tag can never again
/// pass ANY verification gate regardless of what its delegate set contains, and because this registry's
/// writer predicate is deliberately NOT scoped to the tag's original issuer (any Active clinic may act on
/// any `dogTagId`), so a clone-local `rootOfTag` check would incorrectly reject a non-issuing clinic's
/// otherwise-legitimate write. The terminal-status rule is therefore enforced entirely by consumers (the
/// future delegate consent registry re-checks tag status the same way `recordVerificationZK` does today),
/// not by this contract - a deliberate, documented choice, not an oversight.
contract DelegationRegistry is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable {
    /// @notice Fixed tree width: depth-4, 16 leaf slots (plan section 10 item 5; section 13 settlement).
    uint256 public constant TREE_SIZE = 16;
    /// @notice Cap on ACTIVE secondaries per tag (plan section 10 item 5: "cap raised to 11 secondaries
    /// per tag (depth-4 tree, 16 leaves; 11 is fine)").
    uint256 public constant MAX_ACTIVE = 11;
    /// @notice Domain-separation tag for the node hash - byte-identical to
    /// `packages/dogtag-standard-ts/src/field.ts`'s `DS_NODE` and `crates/dogtag-standard-rs`'s mirror,
    /// the SAME node hash the profile tree and every other Merkle root in this protocol already uses.
    /// Cross-checked against `PoseidonT4.hash([DS_NODE, lo, hi])` producing the identical TS `hashNode`
    /// output for multiple vectors (see `test/DelegationRegistry.t.sol`).
    uint256 internal constant DS_NODE = 2;

    /// @notice The fold of sixteen all-zero leaves - `delegationRoot`'s value for a tag that has never
    /// had a secondary owner, or has had every one revoked (plan section 13; `docs/DELEGATION.md` section
    /// 4.2). Independently reproduced from the frozen TS primitives (`buildMerkle`/`toHex32` over sixteen
    /// zero leaves) and pinned identically in `docs/DELEGATION.md` section 4.2 and
    /// `test/DelegationRegistry.t.sol` (which also re-derives it on-chain via four chained
    /// {_hashNode} calls, independent of {_fold}'s own loop).
    bytes32 public constant EMPTY_DELEGATION_ROOT =
        0x08cec144526c6d771c4aad65ad4e8054bc21e6f09b8bdf27c13ba39643fa8ddc;

    /// @notice The BN254 scalar field `r` every Poseidon input in this protocol is an element of
    /// (`VerificationRegistryConsent.SNARK_SCALAR_FIELD`, `packages/dogtag-standard-ts/src/field.ts`'s
    /// `FIELD_P`). A genuine `Poseidon2(Ax, Ay)` commitment is always `< r` by construction; this bound
    /// is enforced on {add} so a malformed or out-of-range `commitment` can never be sorted (by its raw,
    /// un-reduced `uint256` value) differently on-chain than an off-chain observer - who always works
    /// with already-reduced field elements - would sort the identical value, which would otherwise be a
    /// silent way for an on-chain `delegationRoot` to diverge from any independently-recomputed one.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice The `VetIssuerFactory` this registry resolves clone identity through.
    address public immutable factory;
    /// @notice The `EntityRegistry` this registry checks a calling clone's `vetOwner` activity through.
    address public immutable entityRegistry;

    /// @notice One historical entry: a commitment that was added, by which clone, when, and (if since
    /// removed) when it was revoked. `revokedAt == 0` means currently active. Entries are NEVER mutated
    /// in place across a revoke-then-re-add of the SAME commitment value - a re-add pushes a NEW entry,
    /// so the list is a genuine, append-only audit trail (plan section 11.2 item B1: "per-tag list of
    /// {commitment, issuedBy clone, addedAt, revokedAt}").
    struct Delegate {
        bytes32 commitment;
        address issuedBy;
        uint64 addedAt;
        uint64 revokedAt;
    }

    /// @dev dogTagId -> full history, add order, append-only.
    mapping(uint256 => Delegate[]) private _delegates;
    /// @dev dogTagId -> commitment -> (index into `_delegates[dogTagId]`) + 1; 0 means "not currently
    /// active" (never added, or added and since revoked). The `+1` disambiguates "never set" from index 0.
    mapping(uint256 => mapping(bytes32 => uint256)) private _activeEntryIndexPlusOne;
    /// @dev dogTagId -> its current 16 physical tree slots (0 = empty/revoked). {delegationRoot} is this
    /// array folded through {_fold}; kept in storage (rather than derived from `_delegates` on every
    /// read) so both the tree ITSELF and every consumer's read of it are O(1)/O(16), never O(history).
    mapping(uint256 => bytes32[16]) private _leaves;
    /// @notice dogTagId -> count of CURRENTLY ACTIVE secondaries. The cap-11 check on {add} and the
    /// canonical emptiness test for {delegationRoot} - never compare a root against `0`.
    mapping(uint256 => uint256) public secondaryCount;
    /// @dev dogTagId -> the real, incrementally-maintained fold of `_leaves[dogTagId]`. Always kept in
    /// sync with `_leaves` (including at count zero, where it already equals {EMPTY_DELEGATION_ROOT} by
    /// construction) - the public {delegationRoot} accessor layers the explicit `secondaryCount == 0`
    /// branch on top for a correctness guarantee that does not depend on {_fold} alone.
    mapping(uint256 => bytes32) private _delegationRoot;

    event SecondaryOwnerAdded(uint256 indexed dogTagId, bytes32 indexed commitment, address clone);
    event SecondaryOwnerRevoked(uint256 indexed dogTagId, bytes32 indexed commitment, address clone);

    error ZeroAddress();
    error NotAnActiveClone();
    error ZeroCommitment();
    error CommitmentOutOfField();
    error CapReached();
    error DuplicateActiveCommitment();
    error NotCurrentlyASecondaryOwner();
    error RenounceDisabled();

    /// @dev The implementation's `factory`/`entityRegistry` are fixed for its whole life; only the proxy
    /// initializes ownership. Mirrors `VerificationRegistryConsent`'s immutable-dependency pattern, using
    /// this contract's own `Initializable` (rather than a plain constructor-only contract) because this
    /// one IS upgradeable and must still disable direct initialization of the implementation itself.
    constructor(address factory_, address entityRegistry_) {
        if (factory_ == address(0) || entityRegistry_ == address(0)) revert ZeroAddress();
        factory = factory_;
        entityRegistry = entityRegistry_;
        _disableInitializers();
    }

    /// @param owner_ the protocol admin. Receives ownership on the PROXY's own storage.
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
    }

    /// @dev The writer predicate every clone-issued data write in this protocol already uses
    /// (`VetIssuer.onlyActiveOperator`'s own factory/entity check, mirrored here at the registry layer
    /// since the caller here is the CLONE itself, not an operator wallet): `msg.sender` must be a clone
    /// this factory deployed, AND that clone's entity must be currently Active. Deliberately NOT scoped
    /// to any particular clone per `dogTagId` - any Active clinic may add or revoke a secondary on any
    /// tag (Kenneth's decision, plan section 9 item 2).
    modifier onlyActiveClone() {
        if (!IFactoryIsClone(factory).isClone(msg.sender)) revert NotAnActiveClone();
        if (!IEntityRegistryIsActive(entityRegistry).isActive(IVetIssuerVetOwner(msg.sender).vetOwner())) {
            revert NotAnActiveClone();
        }
        _;
    }

    /// @notice Disabled, for the identical reason `EntityRegistry`/`VetIssuerFactory` disable it: every
    /// owner-only mutation here (none exist today beyond the UUPS upgrade path itself, but future ones
    /// would inherit this) would be permanently unreachable with a zeroed `owner()`.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------
    // Add / revoke - clone-gated writes (docs/DELEGATION.md sections 4.3, 4.5)
    // ---------------------------------------------------------------------------------------------

    /// @notice Add `commitment` as a currently-active secondary owner of `dogTagId`.
    /// @dev Rejects a zero commitment, a commitment that is ALREADY currently active on this tag
    /// (duplicate-active), and a 12th active member (cap 11). A commitment that was added and since
    /// revoked may be re-added - it is treated as a brand-new history entry, not a resurrection of the
    /// old one, so the audit trail never loses the fact that it was once revoked.
    function add(uint256 dogTagId, bytes32 commitment) external onlyActiveClone {
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (uint256(commitment) >= SNARK_SCALAR_FIELD) revert CommitmentOutOfField();
        if (_activeEntryIndexPlusOne[dogTagId][commitment] != 0) revert DuplicateActiveCommitment();
        if (secondaryCount[dogTagId] >= MAX_ACTIVE) revert CapReached();

        bytes32[16] storage leaves = _leaves[dogTagId];
        uint256 slot = _findEmptySlot(leaves);
        leaves[slot] = commitment;

        Delegate[] storage history = _delegates[dogTagId];
        history.push(
            Delegate({
                commitment: commitment, issuedBy: msg.sender, addedAt: uint64(block.timestamp), revokedAt: 0
            })
        );
        _activeEntryIndexPlusOne[dogTagId][commitment] = history.length; // length == (new index) + 1

        secondaryCount[dogTagId] += 1;
        _delegationRoot[dogTagId] = _fold(leaves);

        emit SecondaryOwnerAdded(dogTagId, commitment, msg.sender);
    }

    /// @notice Revoke `commitment` from `dogTagId`'s currently-active secondary owners.
    /// @dev Rejects a commitment that is not CURRENTLY active - whether it was never added, or was added
    /// and already revoked. Zeroes the slot in place (never removed/compacted, per `docs/DELEGATION.md`
    /// section 4.5) and recomputes {delegationRoot}.
    function revoke(uint256 dogTagId, bytes32 commitment) external onlyActiveClone {
        uint256 entryIndexPlusOne = _activeEntryIndexPlusOne[dogTagId][commitment];
        if (entryIndexPlusOne == 0) revert NotCurrentlyASecondaryOwner();

        bytes32[16] storage leaves = _leaves[dogTagId];
        uint256 slot = _findSlotOf(leaves, commitment);
        leaves[slot] = bytes32(0);

        _delegates[dogTagId][entryIndexPlusOne - 1].revokedAt = uint64(block.timestamp);
        delete _activeEntryIndexPlusOne[dogTagId][commitment];

        secondaryCount[dogTagId] -= 1;
        _delegationRoot[dogTagId] = _fold(leaves);

        emit SecondaryOwnerRevoked(dogTagId, commitment, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Is `commitment` a CURRENTLY active secondary owner of `dogTagId`?
    function isSecondary(uint256 dogTagId, bytes32 commitment) external view returns (bool) {
        return _activeEntryIndexPlusOne[dogTagId][commitment] != 0;
    }

    /// @notice The full history of secondary-owner entries ever added to `dogTagId`, in add order -
    /// active and revoked alike (`revokedAt == 0` marks a still-active entry). Use {isSecondary} or
    /// {secondaryCount} to answer "currently active" questions in O(1) rather than scanning this list.
    function secondaries(uint256 dogTagId) external view returns (Delegate[] memory) {
        return _delegates[dogTagId];
    }

    /// @notice The tag's current 16 physical tree slots (0 = empty/revoked, else an active commitment).
    /// What a co-owner bundle publishes so a surviving delegate can recompute their own sibling path
    /// (`docs/DELEGATION.md` sections 4.2, 4.5) - the array a consumer folds is exactly this one.
    function delegationLeaves(uint256 dogTagId) external view returns (bytes32[16] memory) {
        return _leaves[dogTagId];
    }

    /// @notice `dogTagId`'s current delegation-tree root. Returns {EMPTY_DELEGATION_ROOT} whenever
    /// {secondaryCount} is zero (never-touched or fully-revoked - the two are indistinguishable by root
    /// alone, by design), and the real incrementally-maintained fold otherwise. This explicit branch is a
    /// belt-and-braces guarantee independent of {_fold}'s own correctness: the empty case is the one a
    /// future verifier's `delegationRoot == delegationRoot(dogTagId)` check most needs to get right.
    function delegationRoot(uint256 dogTagId) public view returns (bytes32) {
        return secondaryCount[dogTagId] == 0 ? EMPTY_DELEGATION_ROOT : _delegationRoot[dogTagId];
    }

    // ---------------------------------------------------------------------------------------------
    // The fold - this protocol's own Merkle convention, applied to a fixed 16-leaf tree
    // ---------------------------------------------------------------------------------------------

    /// @dev Sort all 16 values ascending as field elements, then fold bottom-up in fixed pairs
    /// (16 -> 8 -> 4 -> 2 -> 1). Sixteen is a power of two, so every level has an even count and no
    /// odd-node promotion ever applies - unlike the general-purpose `buildMerkle`, this fold does not
    /// need that branch at all. Every pairing - including ones beyond the first level, where the two
    /// inputs are themselves hash outputs with no a-priori order - applies {_hashNode}'s own per-pair
    /// min/max, exactly mirroring `packages/dogtag-standard-ts/src/merkle.ts`'s `hashNode` being called
    /// at every fold step, not only the first.
    function _fold(bytes32[16] storage leaves) internal view returns (bytes32) {
        uint256[16] memory level;
        for (uint256 i = 0; i < TREE_SIZE; i++) {
            level[i] = uint256(leaves[i]);
        }
        _sortAscending(level);

        uint256 width = TREE_SIZE;
        while (width > 1) {
            uint256 half = width / 2;
            for (uint256 i = 0; i < half; i++) {
                level[i] = _hashNode(level[2 * i], level[2 * i + 1]);
            }
            width = half;
        }
        return bytes32(level[0]);
    }

    /// @dev Commutative pair hash: sort the pair as integers, then `PoseidonT4.hash([DS_NODE, lo, hi])` -
    /// the on-chain form of `packages/dogtag-standard-ts/src/merkle.ts`'s `hashNode`. `poseidon-solidity`
    /// names a 3-input Poseidon call "PoseidonT4" (state width = inputs + 1, not input count).
    function _hashNode(uint256 a, uint256 b) internal pure returns (uint256) {
        (uint256 lo, uint256 hi) = a <= b ? (a, b) : (b, a);
        return PoseidonT4.hash([DS_NODE, lo, hi]);
    }

    /// @dev Insertion sort over exactly 16 elements - O(n^2) is 256 comparisons at worst, cheap at this
    /// fixed size and called at most once per {add}/{revoke}.
    function _sortAscending(uint256[16] memory arr) internal pure {
        for (uint256 i = 1; i < TREE_SIZE; i++) {
            uint256 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
    }

    /// @dev The cap (11 of 16) guarantees an empty slot exists whenever this is reached from {add}.
    function _findEmptySlot(bytes32[16] storage leaves) internal view returns (uint256) {
        for (uint256 i = 0; i < TREE_SIZE; i++) {
            if (leaves[i] == bytes32(0)) return i;
        }
        revert CapReached(); // unreachable given the cap check in {add}; fails closed rather than wrapping
    }

    /// @dev {revoke}'s slot lookup. Unreachable-revert mirrors {_findEmptySlot}: {revoke} already checked
    /// `_activeEntryIndexPlusOne` is non-zero, so `commitment` MUST occupy exactly one of the 16 slots.
    function _findSlotOf(bytes32[16] storage leaves, bytes32 commitment) internal view returns (uint256) {
        for (uint256 i = 0; i < TREE_SIZE; i++) {
            if (leaves[i] == commitment) return i;
        }
        revert NotCurrentlyASecondaryOwner();
    }

    // ---------------------------------------------------------------------------------------------
    // Upgradeability
    // ---------------------------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Reserved storage so a future version can add fields without shifting the layout of anything
    /// declared after this contract in an upgrade. Sized to match the ~50-slot headroom convention this
    /// codebase's other UUPS admin registries use (`EntityRegistry`: 5 declared + 45 gap;
    /// `VetIssuerFactory`: 7 declared + 44 gap) - this contract declares 5 storage-consuming variables
    /// (`_delegates`, `_activeEntryIndexPlusOne`, `_leaves`, `secondaryCount`, `_delegationRoot`;
    /// `factory`/`entityRegistry` are `immutable` and consume no storage slot).
    uint256[45] private __gap;
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.28 ^0.8.20 ^0.8.21;

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

// lib/openzeppelin-contracts/contracts/proxy/utils/Initializable.sol

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
abstract contract Initializable_0 {
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
abstract contract Initializable_1 {
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

// lib/openzeppelin-contracts/contracts/proxy/Proxy.sol

// OpenZeppelin Contracts (last updated v5.0.0) (proxy/Proxy.sol)

/**
 * @dev This abstract contract provides a fallback function that delegates all calls to another contract using the EVM
 * instruction `delegatecall`. We refer to the second contract as the _implementation_ behind the proxy, and it has to
 * be specified by overriding the virtual {_implementation} function.
 *
 * Additionally, delegation to the implementation can be triggered manually through the {_fallback} function, or to a
 * different contract through the {_delegate} function.
 *
 * The success and return data of the delegated call will be returned back to the caller of the proxy.
 */
abstract contract Proxy {
    /**
     * @dev Delegates the current call to `implementation`.
     *
     * This function does not return to its internal call site, it will return directly to the external caller.
     */
    function _delegate(address implementation) internal virtual {
        assembly {
            // Copy msg.data. We take full control of memory in this inline assembly
            // block because it will not return to Solidity code. We overwrite the
            // Solidity scratch pad at memory position 0.
            calldatacopy(0, 0, calldatasize())

            // Call the implementation.
            // out and outsize are 0 because we don't know the size yet.
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)

            // Copy the returned data.
            returndatacopy(0, 0, returndatasize())

            switch result
            // delegatecall returns 0 on error.
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /**
     * @dev This is a virtual function that should be overridden so it returns the address to which the fallback
     * function and {_fallback} should delegate.
     */
    function _implementation() internal view virtual returns (address);

    /**
     * @dev Delegates the current call to the address returned by `_implementation()`.
     *
     * This function does not return to its internal call site, it will return directly to the external caller.
     */
    function _fallback() internal virtual {
        _delegate(_implementation());
    }

    /**
     * @dev Fallback function that delegates calls to the address returned by `_implementation()`. Will run if no other
     * function in the contract matches the call data.
     */
    fallback() external payable virtual {
        _fallback();
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
abstract contract ContextUpgradeable is Initializable_1 {
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
abstract contract OwnableUpgradeable is Initializable_1, ContextUpgradeable {
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
abstract contract Ownable2StepUpgradeable is Initializable_1, OwnableUpgradeable {
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

// lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol

// OpenZeppelin Contracts (last updated v5.1.0) (proxy/ERC1967/ERC1967Proxy.sol)

/**
 * @dev This contract implements an upgradeable proxy. It is upgradeable because calls are delegated to an
 * implementation address that can be changed. This address is stored in storage in the location specified by
 * https://eips.ethereum.org/EIPS/eip-1967[ERC-1967], so that it doesn't conflict with the storage layout of the
 * implementation behind the proxy.
 */
contract ERC1967Proxy is Proxy {
    /**
     * @dev Initializes the upgradeable proxy with an initial implementation specified by `implementation`.
     *
     * If `_data` is nonempty, it's used as data in a delegate call to `implementation`. This will typically be an
     * encoded function call, and allows initializing the storage of the proxy like a Solidity constructor.
     *
     * Requirements:
     *
     * - If `data` is empty, `msg.value` must be zero.
     */
    constructor(address implementation, bytes memory _data) payable {
        ERC1967Utils.upgradeToAndCall(implementation, _data);
    }

    /**
     * @dev Returns the current implementation address.
     *
     * TIP: To get this value clients can read directly from the storage slot shown below (specified by ERC-1967) using
     * the https://eth.wiki/json-rpc/API#eth_getstorageat[`eth_getStorageAt`] RPC call.
     * `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
     */
    function _implementation() internal view virtual override returns (address) {
        return ERC1967Utils.getImplementation();
    }
}

// lib/openzeppelin-contracts/contracts/proxy/utils/UUPSUpgradeable.sol

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
abstract contract UUPSUpgradeable_0 is IERC1822Proxiable {
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
abstract contract UUPSUpgradeable_1 is Initializable_1, IERC1822Proxiable {
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

// src/VetIssuer.sol

/// @notice The `VetIssuerFactory` surface this clone depends on: its admin (the factory's own owner),
/// the `EntityRegistry` it resolves entity status through, the shared `DogTagSBTConsent`, and the
/// write-once root index every clone registers into.
interface IVetIssuerFactory {
    function owner() external view returns (address);
    function registry() external view returns (address);
    function sbt() external view returns (address);
    function indexRoot(bytes32 root) external;
}

interface IEntityRegistryView {
    function isActive(address account) external view returns (bool);
}

interface IDogTagSBTMint {
    function mintCustodial(uint256 id, bytes32 root) external;
}

/// @notice The `DelegationRegistry` surface {addSecondaryOwner}/{revokeSecondaryOwner} write through
/// (`contracts/src/DelegationRegistry.sol`; `docs/DELEGATION.md` sections 4.3, 4.5).
interface IDelegationRegistry {
    function add(uint256 dogTagId, bytes32 commitment) external;
    function revoke(uint256 dogTagId, bytes32 commitment) external;
}

/// @notice The `VerificationRegistryConsent` surface {relayVerification} relays a consent proof through,
/// naming THIS CLONE as `relayer` (`contracts/src/VerificationRegistryConsent.sol`; `docs/DELEGATION.md`
/// section 7's "relayVerification is a new relayer" note).
interface IVerificationRegistryConsentRelay {
    function recordVerificationZK(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[7] calldata pub
    ) external;
}

/// @title VetIssuer - per-entity issuer, UUPS behind a per-clone `ERC1967Proxy`.
///
/// @notice Replaces v1 `DogTagIssuer` clones. One `VetIssuer` proxy per approved entity, deployed by
/// `VetIssuerFactory`. Whitelisted operators issue and revoke dogtags and credential records; the clone
/// pays its operators' gas out of its own native balance.
///
/// # v2.1.0 (WP4.15): vet-issued secondary owners, and relaying a consent proof
///
/// Storage-compatible upgrade of the SAME per-clone proxy (no new clone type): {initializeDelegation}
/// (`reinitializer(2)`, `onlyFactoryAdmin`) wires this clone to a shared `DelegationRegistry` and to
/// `VerificationRegistryConsent`; {addSecondaryOwner}/{revokeSecondaryOwner} let any currently-Active
/// clinic add or remove a secondary owner's key commitment on any `dogTagIdField`, sponsored the same way
/// as {issueTag}; {relayVerification} lets this clone submit a consent proof as `VerificationRegistryConsent`'s
/// `relayer`, sponsored the same way. See `docs/DELEGATION.md` for the full model and
/// `docs/DEPLOY-wp4.15.md` for the upgrade + per-clone follow-up runbook.
///
/// @dev This clone's authorization (`onlyFactoryAdmin`/`onlyOperator`) and reentrancy guard
/// (`refundsGas`'s `_refundLock`) are hand-rolled rather than pulled from `Ownable`/`ReentrancyGuard`: the
/// admin here is not this contract's own owner but the FACTORY's, read live through {factoryAdmin}, which
/// neither OZ module models. `Initializable`/`UUPSUpgradeable` themselves ARE used directly from OZ (both
/// initializer-safe, proxy-oriented by design) - see `EntityRegistry`'s contract doc for the vendored
/// `openzeppelin-contracts-upgradeable` package that `EntityRegistry`/`VetIssuerFactory` use for their own
/// (ordinary, single-owner) `Ownable2StepUpgradeable`, which this contract's admin model does not fit.
///
/// # Atomic issuance (v2 removes the v1 issue-then-mint ordering hazard)
///
/// v1 required a caller to `DogTagIssuer.issue(root)` and separately `DogTagSBTConsent.mintCustodial(...)`
/// in two transactions; a crash between them left a minted, unverifiable tag (`unknown root`) or an
/// anchored root with no tag. {issueTag} does both in one transaction.
///
/// # Revoke/reactivate is a clone-local, REVERSIBLE root flag - not an SBT status write
///
/// `DogTagSBTConsent.setStatus` treats `Deceased` and `Revoked` as TERMINAL
/// (`if (f == Status.Deceased || f == Status.Revoked) revert Terminal();`) and that is a hard-constrained,
/// unchanged v1 semantic. Routing {revokeTag}/{reactivateTag} through `sbt.setStatus(id, Revoked, ...)`
/// as literally described in the v2 spec would therefore make `reactivateTag` permanently unreachable
/// after one revoke (the SBT call reverts `Terminal`), and - worse - even bypassing that call could not
/// un-terminal the SBT's own status, so `VerificationRegistryConsent`'s M-1 gate (`status` not
/// `Deceased`/`Revoked`) would keep rejecting every proof forever regardless of this clone's own state.
/// That is incompatible with the required "revoke fails verification, reactivate restores" flow (M-1
/// acceptance anchor #3), so {revokeTag}/{reactivateTag} manage ONLY this clone's own root validity
/// (`isValid`, the `cred !valid` gate) and never call `sbt.setStatus`. The SBT's own terminal lifecycle
/// (`Deceased`, a PERMANENT `Revoked`) stays reachable through `AUTHORITY_ROLE` directly on the SBT, for
/// the genuinely irreversible cases (GDPR erasure candidate, replace flow leaving the old tag dead for
/// good) - see `contracts/DEVIATIONS.md` (D-1) for the full trace, the acceptance anchor this protects,
/// and the test that pins it.
contract VetIssuer is Initializable_0, UUPSUpgradeable_0 {
    /// @notice `keccak256("DOG_PROFILE")` - the profile tree label. Byte-identical to
    /// `crates/dogtag-standard-rs/src/schema.rs` / `verify.rs:record_type_key`; mobile consent assembly
    /// encodes it into public signals, so it must never change.
    bytes32 public constant RECORD_TYPE_PROFILE = keccak256("DOG_PROFILE");
    bytes32 public constant RECORD_TYPE_VACCINATION = keccak256("VACCINATION");
    bytes32 public constant RECORD_TYPE_TRAVEL_CLEARANCE = keccak256("TRAVEL_CLEARANCE");
    bytes32 public constant RECORD_TYPE_EU_HEALTH_CERT = keccak256("EU_HEALTH_CERT");
    /// @notice Art. 9: structurally refused by {issueRecord} AND by `VerificationRegistryConsent`
    /// (§11.9(h)) - kept here only so {issueRecord} can name it in its guard.
    bytes32 public constant RECORD_TYPE_SERVICE_ATTESTATION = keccak256("SERVICE_ATTESTATION");

    /// @notice Gas-refund overhead: the base transaction cost and the refund transfer itself are not
    /// visible to the in-function `gasleft()` measurement, so this is added before pricing the refund.
    uint256 public constant REFUND_OVERHEAD = 35_000;

    /// @notice The `VetIssuerFactory` that deployed this clone. Set once, at {initialize}; no setter.
    address public factory;
    /// @notice The entity account this clone issues for - the `EntityRegistry` key whose `isActive`
    /// status gates every issue-path call.
    address public vetOwner;

    /// @notice Whitelisted callers. Mutation is `onlyFactoryAdmin` ONLY - a product rule that only the
    /// DogTag admin manages whitelists on every vet contract, never the vet itself.
    mapping(address => bool) public operators;

    /// @notice The refund ceiling per operator call, in wei. `onlyFactoryAdmin`-settable.
    uint256 public maxRefund;

    // ---- the unified per-root registry: PROFILE roots (tags) and credential-record roots share it,
    // because `isValid(root)` and `VerificationRegistryConsent`'s `cred !valid` gate must answer for
    // either kind identically. ----
    mapping(bytes32 => uint64) public issuedAt; // 0 = never issued here
    mapping(bytes32 => uint64) public revokedAt; // 0 = not currently revoked
    mapping(bytes32 => address) public issuedBy;
    mapping(bytes32 => bytes32) public recordTypeOf;

    // ---- the id<->root binding, PROFILE roots only ----
    mapping(uint256 => bytes32) public rootOfTag;
    mapping(bytes32 => uint256) public tagOfRoot;

    uint256 private _refundLock; // 0 = unlocked, 1 = locked - hand-rolled `nonReentrant` for {refundsGas}

    // ---- WP4.15 (v2.1.0): storage APPENDED here, after every v2.0.0 field and before `__gap`, which
    // shrinks by exactly 2 slots (40 -> 38) to make room - see `__gap`'s own doc comment. ----

    /// @notice The `DelegationRegistry` {addSecondaryOwner}/{revokeSecondaryOwner} write through. Zero
    /// until {initializeDelegation} runs on this clone (every clone upgraded to v2.1.0 needs that
    /// one-time follow-up call - see `docs/DEPLOY-wp4.15.md`).
    address public delegationRegistry;
    /// @notice The `VerificationRegistryConsent` {relayVerification} relays a consent proof through,
    /// naming this clone as `relayer`. Zero until {initializeDelegation} runs on this clone.
    address public verificationRegistry;

    event VetIssuerInitialized(address indexed vetOwner, address indexed factory);
    event OperatorSet(address indexed operator, bool allowed);
    event VetOwnerSet(address indexed oldOwner, address indexed newOwner);
    event MaxRefundSet(uint256 amount);
    event TagIssued(uint256 indexed dogTagIdField, bytes32 indexed root, address operator);
    event TagRevoked(uint256 indexed dogTagIdField, bytes32 root, bytes32 reasonCode, address by);
    event TagReactivated(uint256 indexed dogTagIdField, bytes32 root, bytes32 reasonCode, address by);
    event RecordIssued(bytes32 indexed recordType, bytes32 indexed root, address operator);
    event RecordRevoked(bytes32 indexed root, bytes32 reasonCode, address by);
    event RecordReactivated(bytes32 indexed root, bytes32 reasonCode, address by);
    event RefundSkipped(address indexed operator, uint256 wanted);
    event FundsReceived(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotFactoryAdmin();
    error NotOperator();
    error EntityNotActive();
    error ZeroRoot();
    error RootAlreadyIssued();
    error TagAlreadyIssued();
    error UnknownTag();
    error UnknownRoot();
    error AlreadyRevoked();
    error NotCurrentlyRevoked();
    error InvalidRecordType(bytes32 recordType);
    error NotAuthorizedToUpgrade();
    error Reentrant();
    error WithdrawFailed();
    error DelegationRegistryNotConfigured();
    error VerificationRegistryNotConfigured();

    /// @dev The implementation is locked at construction; only clones (behind their own `ERC1967Proxy`)
    /// initialize.
    constructor() {
        _disableInitializers();
    }

    modifier onlyFactoryAdmin() {
        if (msg.sender != factoryAdmin()) revert NotFactoryAdmin();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    /// @dev The issue-path gate: whitelisted AND the entity is currently Active. Revocation of the
    /// business freezes new issuance but must not touch already-issued roots - see {isValid}, which
    /// consults only this clone's own root registry and never the entity's status.
    modifier onlyActiveOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        if (!IEntityRegistryView(IVetIssuerFactory(factory).registry()).isActive(vetOwner)) {
            revert EntityNotActive();
        }
        _;
    }

    /// @dev Measures gas from entry, refunds `(gasUsed + REFUND_OVERHEAD) * tx.gasprice` to `msg.sender`
    /// after the wrapped action runs, capped at {maxRefund}. An underfunded clone skips the refund and
    /// emits {RefundSkipped}; the wrapped action itself still succeeds either way. `nonReentrant`, and the
    /// refund is the LAST thing this modifier does.
    modifier refundsGas() {
        if (_refundLock == 1) revert Reentrant();
        _refundLock = 1;
        uint256 gasStart = gasleft();
        _;
        uint256 gasUsed = gasStart - gasleft();
        uint256 wanted = (gasUsed + REFUND_OVERHEAD) * tx.gasprice;
        uint256 amount = wanted > maxRefund ? maxRefund : wanted;
        // The lock stays held THROUGH the transfer, not just through the wrapped action: `nonReentrant`
        // guards the call this modifier makes, not only the call it wraps, and unlocking before the
        // transfer would let a reentering recipient re-enter an operator mutation mid-refund.
        if (amount > 0) {
            if (address(this).balance < amount) {
                emit RefundSkipped(msg.sender, wanted);
            } else {
                (bool ok,) = payable(msg.sender).call{value: amount}("");
                if (!ok) emit RefundSkipped(msg.sender, wanted);
            }
        }
        _refundLock = 0;
    }

    /// @param vetOwner_ the entity account (an `EntityRegistry` key) this clone issues for.
    /// @param factory_ the `VetIssuerFactory` that deployed this clone.
    function initialize(address vetOwner_, address factory_) external initializer {
        if (vetOwner_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        vetOwner = vetOwner_;
        factory = factory_;
        maxRefund = 0.05 ether;
        emit VetIssuerInitialized(vetOwner_, factory_);
    }

    /// @notice The factory's own owner, read LIVE - never cached, so a factory ownership handover takes
    /// effect on every clone immediately.
    function factoryAdmin() public view returns (address) {
        return IVetIssuerFactory(factory).owner();
    }

    // ---------------------------------------------------------------------------------------------
    // Whitelist - admin-only in both directions (product rule)
    // ---------------------------------------------------------------------------------------------

    /// @notice Whitelist `operator` to call every operator-gated function on this clone.
    /// @dev `onlyFactoryAdmin`, never the vet itself - the product rule that only the DogTag admin manages
    /// whitelists on every vet contract. Rejects a zero address.
    function addOperator(address operator) external onlyFactoryAdmin {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = true;
        emit OperatorSet(operator, true);
    }

    /// @notice Remove `operator` from the whitelist. A no-op (still emits) if it was never whitelisted.
    /// @dev `onlyFactoryAdmin`, same as {addOperator}.
    function removeOperator(address operator) external onlyFactoryAdmin {
        operators[operator] = false;
        emit OperatorSet(operator, false);
    }

    /// @notice Repoint which `EntityRegistry` account this clone issues for. Paired with
    /// `VetIssuerFactory.syncCloneOwner`, which calls this DIRECTLY (as the factory contract, not as its
    /// owner) - see that function's doc for the two-step admin flow.
    /// @dev Callable by the factory's current owner directly, OR by the factory contract itself (the
    /// `msg.sender == factory` arm is what lets `syncCloneOwner` call straight through). The same
    /// either-or shape {_authorizeUpgrade} already uses, for the same reason: a factory-mediated action
    /// must reach the clone under the factory's own address, which is never equal to `factoryAdmin()`.
    function setVetOwner(address newVetOwner) external {
        if (msg.sender != factory && msg.sender != factoryAdmin()) revert NotFactoryAdmin();
        if (newVetOwner == address(0)) revert ZeroAddress();
        address old = vetOwner;
        vetOwner = newVetOwner;
        emit VetOwnerSet(old, newVetOwner);
    }

    // ---------------------------------------------------------------------------------------------
    // Tag issuance - atomic anchor + mint, one transaction
    // ---------------------------------------------------------------------------------------------

    /// @notice Anchor a PROFILE root and custodially mint the tag in one transaction.
    /// @dev Rejects a zero root, a root already issued here (by either {issueTag} or {issueRecord}), and
    /// a `dogTagIdField` already bound to a root. Order: record locally, index into the factory, THEN
    /// mint - so a revert on the mint (e.g. the clone lacks `ISSUER_ROLE`) leaves no partial root index.
    function issueTag(uint256 dogTagIdField, bytes32 root) external onlyActiveOperator refundsGas {
        if (root == bytes32(0)) revert ZeroRoot();
        if (issuedAt[root] != 0) revert RootAlreadyIssued();
        if (rootOfTag[dogTagIdField] != bytes32(0)) revert TagAlreadyIssued();

        issuedAt[root] = uint64(block.timestamp);
        issuedBy[root] = msg.sender;
        recordTypeOf[root] = RECORD_TYPE_PROFILE;
        rootOfTag[dogTagIdField] = root;
        tagOfRoot[root] = dogTagIdField;

        IVetIssuerFactory(factory).indexRoot(root);
        IDogTagSBTMint(IVetIssuerFactory(factory).sbt()).mintCustodial(dogTagIdField, root);

        emit TagIssued(dogTagIdField, root, msg.sender);
    }

    /// @notice Revoke a tag's root: {isValid} answers false and `VerificationRegistryConsent` rejects it
    /// with `cred !valid`. Reversible - see {reactivateTag} and `DEVIATIONS.md` (D-1) for why this never
    /// calls `sbt.setStatus`.
    function revokeTag(uint256 dogTagIdField, bytes32 reasonCode) external onlyOperator refundsGas {
        bytes32 root = rootOfTag[dogTagIdField];
        if (root == bytes32(0)) revert UnknownTag();
        if (revokedAt[root] != 0) revert AlreadyRevoked();
        revokedAt[root] = uint64(block.timestamp);
        emit TagRevoked(dogTagIdField, root, reasonCode, msg.sender);
    }

    /// @notice Clear a tag's revocation: {isValid} answers true again and verification resumes.
    function reactivateTag(uint256 dogTagIdField, bytes32 reasonCode) external onlyOperator refundsGas {
        bytes32 root = rootOfTag[dogTagIdField];
        if (root == bytes32(0)) revert UnknownTag();
        if (revokedAt[root] == 0) revert NotCurrentlyRevoked();
        revokedAt[root] = 0;
        emit TagReactivated(dogTagIdField, root, reasonCode, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Credential records - vaccination, travel, future government flows
    // ---------------------------------------------------------------------------------------------

    /// @notice Anchor a credential-document root. `recordType` must be a known non-PROFILE,
    /// non-SERVICE_ATTESTATION constant (§11.9(h) - Art. 9 is structurally refused here too, ahead of the
    /// verification registry's own guard).
    function issueRecord(bytes32 recordType, bytes32 root) external onlyActiveOperator refundsGas {
        if (
            recordType != RECORD_TYPE_VACCINATION && recordType != RECORD_TYPE_TRAVEL_CLEARANCE
                && recordType != RECORD_TYPE_EU_HEALTH_CERT
        ) {
            revert InvalidRecordType(recordType);
        }
        if (root == bytes32(0)) revert ZeroRoot();
        if (issuedAt[root] != 0) revert RootAlreadyIssued();

        issuedAt[root] = uint64(block.timestamp);
        issuedBy[root] = msg.sender;
        recordTypeOf[root] = recordType;

        IVetIssuerFactory(factory).indexRoot(root);
        emit RecordIssued(recordType, root, msg.sender);
    }

    /// @notice Revoke a credential-record root: {isValid} answers false for it. Reversible - see
    /// {reactivateRecord}.
    function revokeRecord(bytes32 root, bytes32 reasonCode) external onlyOperator refundsGas {
        if (issuedAt[root] == 0) revert UnknownRoot();
        if (revokedAt[root] != 0) revert AlreadyRevoked();
        revokedAt[root] = uint64(block.timestamp);
        emit RecordRevoked(root, reasonCode, msg.sender);
    }

    /// @notice Clear a credential-record root's revocation: {isValid} answers true again.
    function reactivateRecord(bytes32 root, bytes32 reasonCode) external onlyOperator refundsGas {
        if (issuedAt[root] == 0) revert UnknownRoot();
        if (revokedAt[root] == 0) revert NotCurrentlyRevoked();
        revokedAt[root] = 0;
        emit RecordReactivated(root, reasonCode, msg.sender);
    }

    /// @notice `VerificationRegistryConsent`'s `cred !valid` gate: root known here, issued, not currently
    /// revoked. Signature-compatible with the v1 `DogTagIssuer.isValid` the registry called before.
    /// Deliberately does NOT consult the entity's `EntityRegistry` status - see the {onlyActiveOperator}
    /// doc: a revoked entity freezes new issuance without invalidating what it already issued.
    function isValid(bytes32 root) external view returns (bool) {
        return issuedAt[root] != 0 && revokedAt[root] == 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Delegation (v2.1.0, WP4.15) - vet-issued secondary owners, and relaying a consent proof
    // ---------------------------------------------------------------------------------------------

    /// @notice One-time, per-clone follow-up to a v2.1.0 upgrade: wires this clone to the shared
    /// `DelegationRegistry` and `VerificationRegistryConsent` deployments.
    /// @dev `reinitializer(2)`: callable once per clone, only after that clone's original `initialize`
    /// (version 1) has run. `VetIssuerFactory.upgradeClone(s)` (frozen, byte-identical this wave) calls
    /// `upgradeToAndCall(newImpl, "")` with EMPTY data, so this cannot run atomically with the bytecode
    /// upgrade itself - it is a deliberate second transaction, which is why it is ALSO `onlyFactoryAdmin`:
    /// without that guard, any address could win a race to call this first with an address of its own
    /// choosing, since `reinitializer(2)` alone gates versioning, not the caller's identity. The same key
    /// that calls `upgradeClone` calls this next, for every existing clone AND for every clone deployed
    /// after this upgrade ships (`VetIssuerFactory.deployVet`'s `initData` is fixed to the version-1
    /// `initialize` call only - see `docs/DEPLOY-wp4.15.md` for the required per-clone follow-up).
    function initializeDelegation(address delegationRegistry_, address verificationRegistry_)
        external
        onlyFactoryAdmin
        reinitializer(2)
    {
        if (delegationRegistry_ == address(0) || verificationRegistry_ == address(0)) {
            revert ZeroAddress();
        }
        delegationRegistry = delegationRegistry_;
        verificationRegistry = verificationRegistry_;
    }

    /// @notice Add `commitment` as a secondary owner of `dogTagIdField`, via the vet-issued ceremony
    /// (`docs/DELEGATION.md` section 4.3). No ZK consent from the primary is required for this call
    /// (Kenneth's decision, plan section 9 item 1) - the clinic's attestation, with the primary present,
    /// is the trust model, identical to issuance's own.
    /// @dev `onlyActiveOperator refundsGas`, the same gate and gas sponsorship as {issueTag}/{issueRecord}.
    /// Any currently-Active clinic may call this for any `dogTagIdField`, not only the tag's original
    /// issuer (plan section 9 item 2) - this clone therefore does NOT check its own {rootOfTag} here,
    /// which would incorrectly reject a non-issuing clinic's otherwise-legitimate call.
    function addSecondaryOwner(uint256 dogTagIdField, bytes32 commitment)
        external
        onlyActiveOperator
        refundsGas
    {
        if (delegationRegistry == address(0)) revert DelegationRegistryNotConfigured();
        IDelegationRegistry(delegationRegistry).add(dogTagIdField, commitment);
    }

    /// @notice Revoke `commitment` as a secondary owner of `dogTagIdField` (`docs/DELEGATION.md` section
    /// 4.5). Needs no participation from the secondary owner's own device - staff and the operator wallet
    /// alone suffice, exactly like {addSecondaryOwner}.
    /// @dev `onlyActiveOperator refundsGas`, same non-issuer-scoped writer predicate as {addSecondaryOwner}.
    function revokeSecondaryOwner(uint256 dogTagIdField, bytes32 commitment)
        external
        onlyActiveOperator
        refundsGas
    {
        if (delegationRegistry == address(0)) revert DelegationRegistryNotConfigured();
        IDelegationRegistry(delegationRegistry).revoke(dogTagIdField, commitment);
    }

    /// @notice Relay a primary or (once Stage C ships) delegate consent proof to
    /// `VerificationRegistryConsent.recordVerificationZK`, with THIS CLONE as `msg.sender` - i.e. as the
    /// proof's `relayer` (`pub[2]`), gas-sponsored the same way every other clone data-write is.
    /// @dev The owner's app MUST set the public signal `pub[2]` (`relayer`) to THIS CLONE's own address
    /// before proving, since `recordVerificationZK` requires `address(uint160(pub[2])) == msg.sender` and
    /// `msg.sender` there is this clone when reached through this function. The protocol admin must ALSO
    /// separately whitelist this clone as a verifier for the relevant purpose
    /// (`EntityRegistry.setVerifierCapability(purpose, address(this), true)`) - `recordVerificationZK`'s
    /// `restrictToApprovedRelayers` gate checks `entityRegistry.canVerify(purpose, msg.sender)` against
    /// WHOEVER called it, which is this clone here, not the app or the operator wallet. Neither
    /// requirement is enforced by this function itself - see `docs/DELEGATION.md` section 7 and
    /// `docs/DEPLOY-wp4.15.md`'s verification checklist.
    function relayVerification(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[7] calldata pub
    ) external onlyActiveOperator refundsGas {
        if (verificationRegistry == address(0)) {
            revert VerificationRegistryNotConfigured();
        }
        IVerificationRegistryConsentRelay(verificationRegistry).recordVerificationZK(a, b, c, pub);
    }

    // ---------------------------------------------------------------------------------------------
    // Gas sponsorship
    // ---------------------------------------------------------------------------------------------

    /// @notice Set the per-call refund ceiling {refundsGas} pays out, in wei.
    /// @dev `onlyFactoryAdmin`. Takes effect on the next operator call; does not retroactively affect one
    /// already in flight.
    function setMaxRefund(uint256 amount) external onlyFactoryAdmin {
        maxRefund = amount;
        emit MaxRefundSet(amount);
    }

    /// @notice Accept a native top-up from anyone - the balance {refundsGas} pays operator refunds from.
    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }

    /// @notice Withdraw native balance to `to`.
    /// @dev `onlyFactoryAdmin`. Rejects a zero `to`; reverts {WithdrawFailed} if the transfer itself fails.
    function withdraw(address payable to, uint256 amount) external onlyFactoryAdmin {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Versioning and upgrade authorization
    // ---------------------------------------------------------------------------------------------

    /// @notice The implementation's semantic version. Overridden by any future implementation this
    /// contract is upgraded to.
    function version() external pure virtual returns (string memory) {
        return "2.1.0";
    }

    /// @dev Either the factory itself (batch `upgradeClones`) or the factory's current owner (targeted
    /// `upgradeClone`) may upgrade this clone. Neither the vet owner nor an operator may.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != factory && msg.sender != factoryAdmin()) revert NotAuthorizedToUpgrade();
    }

    /// @dev Reserved storage so a future version can add fields without shifting the layout of anything
    /// declared after this contract in an upgrade. Was `uint256[40]` through v2.0.0; v2.1.0 (WP4.15)
    /// appends {delegationRegistry}/{verificationRegistry} (2 slots) directly above and shrinks this by
    /// the same 2, so the LAST reserved slot's absolute position is unchanged - see
    /// `test/VetIssuerStorageLayout.t.sol` for the `forge inspect storage-layout` proof.
    uint256[38] private __gap;
}

// src/VetIssuerFactory.sol

interface IEntityRegistryActive {
    function isActive(address account) external view returns (bool);
}

/// @notice The upgrade surface every deployed clone exposes (OZ `UUPSUpgradeable`).
interface IUpgradeableClone {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// @title VetIssuerFactory - admin-driven deployment of `VetIssuer` clones.
///
/// @notice Replaces v1 `DogTagIssuerFactory`. v1 was provider self-service; v2 is admin-only by product
/// decision - the DogTag admin platform deploys a vet's clone from the same screen that approves it.
///
/// @dev UUPS upgradeable, `Ownable2StepUpgradeable`-controlled, matching the spec's contract header
/// exactly - see `EntityRegistry`'s contract doc for the vendored-package rationale, which applies here
/// unchanged.
///
/// Also the v1-compatible write-once root index: `rootIssuer[R]` is exactly the mapping
/// `VerificationRegistryConsent.rootIndex` resolves every anchored root through, writable only by one of
/// this factory's own registered clones (see {indexRoot}).
contract VetIssuerFactory is Initializable_1, UUPSUpgradeable_1, Ownable2StepUpgradeable {
    /// @notice The `EntityRegistry` this factory gates `deployVet` against.
    address public registry;
    /// @notice The shared `DogTagSBTConsent` every clone mints through. SBT issuer rights for a clone are
    /// granted by the admin as a SEPARATE transaction - deliberately not coupled to {deployVet}.
    address public sbt;
    /// @notice The `VetIssuer` implementation new clones are deployed against. Admin-replaceable so the
    /// editor can deploy a new implementation and point future clones at it without touching existing ones.
    address public defaultImplementation;

    /// @notice entityAccount -> its deployed clone (zero if none yet).
    mapping(address => address) public cloneOf;
    /// @notice Whether an address is a clone this factory deployed.
    mapping(address => bool) public isClone;
    address[] private _clones;

    /// @notice R -> issuing clone, write-once. The protocol's root index - the address
    /// `VerificationRegistryConsent.rootIndex` names, and the mapping every verifier resolves a
    /// credential's issuing clone through.
    mapping(bytes32 => address) public rootIssuer;

    event DefaultImplementationSet(address indexed implementation);
    event VetDeployed(address indexed entityAccount, address indexed clone, address implementation);
    event CloneOwnerSynced(address indexed oldAccount, address indexed newAccount, address indexed clone);
    event CloneUpgraded(address indexed clone, address indexed newImplementation);
    event RootIndexed(bytes32 indexed root, address indexed clone);

    error ZeroAddress();
    error NotAContract(address dependency);
    error EntityNotActive(address account);
    error CloneAlreadyExists(address account);
    error UnknownAccount(address account);
    error DuplicateTargetAccount(address account);
    error NoDefaultImplementation();
    error NotAClone(address candidate);
    error RootAlreadyIndexed();
    error RenounceDisabled();

    /// @dev The implementation is locked at construction; only the proxy initializes.
    constructor() {
        _disableInitializers();
    }

    /// @param owner_ the factory admin. Receives ownership on the PROXY's own storage.
    function initialize(address owner_, address registry_, address sbt_) external initializer {
        if (owner_ == address(0) || registry_ == address(0) || sbt_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        registry = registry_;
        sbt = sbt_;
    }

    // ---------------------------------------------------------------------------------------------
    // Ownership
    // ---------------------------------------------------------------------------------------------

    /// @notice Disabled. Renouncing would zero `owner()`, and every deployed `VetIssuer` clone reads
    /// this factory's owner LIVE via `factoryAdmin()` on every whitelist, withdraw, and upgrade call -
    /// a renounced factory would permanently brick that surface on every clone that exists today or is
    /// deployed later, with no recovery path. Mirrors the v1 `DogTagIssuer.renounceOwnership`
    /// precedent (`OwnerCannotBeZero`).
    /// @dev Overrides `OwnableUpgradeable.renounceOwnership` (`public virtual onlyOwner`), keeping the
    /// same visibility and the `onlyOwner` modifier so a non-owner caller still reverts with
    /// `OwnableUnauthorizedAccount`; only the current owner reaches {RenounceDisabled}. Narrowed to
    /// `view` since the body only reverts and never writes state - a legal override, the same
    /// direction the v1 `DogTagIssuer.renounceOwnership` precedent narrowed to `pure`.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------
    // Implementation management
    // ---------------------------------------------------------------------------------------------

    /// @notice Point future {deployVet} calls at a new `VetIssuer` implementation. Does not touch any
    /// existing clone - see {upgradeClone}/{upgradeClones} for that.
    function setDefaultImplementation(address impl) external onlyOwner {
        if (impl == address(0)) revert ZeroAddress();
        if (impl.code.length == 0) revert NotAContract(impl);
        defaultImplementation = impl;
        emit DefaultImplementationSet(impl);
    }

    // ---------------------------------------------------------------------------------------------
    // Deployment
    // ---------------------------------------------------------------------------------------------

    /// @notice Deploy `entityAccount`'s `VetIssuer` clone on the current {defaultImplementation}.
    /// @dev Requires the entity to be Active in {registry} and that no clone exists for it yet. Grants no
    /// SBT role - the admin does that separately, on the newly-returned clone address.
    function deployVet(address entityAccount) external onlyOwner returns (address clone) {
        if (entityAccount == address(0)) revert ZeroAddress();
        if (defaultImplementation == address(0)) revert NoDefaultImplementation();
        if (!IEntityRegistryActive(registry).isActive(entityAccount)) revert EntityNotActive(entityAccount);
        if (cloneOf[entityAccount] != address(0)) revert CloneAlreadyExists(entityAccount);

        bytes memory initData = abi.encodeCall(VetIssuer.initialize, (entityAccount, address(this)));
        clone = address(new ERC1967Proxy(defaultImplementation, initData));

        cloneOf[entityAccount] = clone;
        isClone[clone] = true;
        _clones.push(clone);

        emit VetDeployed(entityAccount, clone, defaultImplementation);
    }

    /// @notice Repoint the factory's `cloneOf` lookup after `EntityRegistry.updateEntityAccount`, and set
    /// the clone's own `vetOwner` to match - the deliberate two-step admin flow: move the entity record
    /// first, then call this to keep the registry and the factory consistent.
    function syncCloneOwner(address oldAccount, address newAccount) external onlyOwner {
        if (newAccount == address(0)) revert ZeroAddress();
        address clone = cloneOf[oldAccount];
        if (clone == address(0)) revert UnknownAccount(oldAccount);
        if (cloneOf[newAccount] != address(0)) revert DuplicateTargetAccount(newAccount);

        delete cloneOf[oldAccount];
        cloneOf[newAccount] = clone;
        VetIssuer(payable(clone)).setVetOwner(newAccount);

        emit CloneOwnerSynced(oldAccount, newAccount, clone);
    }

    // ---------------------------------------------------------------------------------------------
    // Per-clone upgrades
    // ---------------------------------------------------------------------------------------------

    /// @notice Upgrade one clone. Calling FROM this factory satisfies `VetIssuer._authorizeUpgrade`'s
    /// `msg.sender == factory` arm regardless of who currently holds this factory's own ownership.
    function upgradeClone(address clone, address newImpl) public onlyOwner {
        if (!isClone[clone]) revert NotAClone(clone);
        IUpgradeableClone(clone).upgradeToAndCall(newImpl, "");
        emit CloneUpgraded(clone, newImpl);
    }

    /// @notice Batch form of {upgradeClone}, one implementation for every listed clone.
    function upgradeClones(address[] calldata clones_, address newImpl) external onlyOwner {
        for (uint256 i; i < clones_.length; i++) {
            upgradeClone(clones_[i], newImpl);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The write-once root index - v1-compatible
    // ---------------------------------------------------------------------------------------------

    /// @notice Write-once registration of `root -> issuing clone`. Caller must be a registered clone.
    function indexRoot(bytes32 root) external {
        if (!isClone[msg.sender]) revert NotAClone(msg.sender);
        if (rootIssuer[root] != address(0)) revert RootAlreadyIndexed();
        rootIssuer[root] = msg.sender;
        emit RootIndexed(root, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice How many clones this factory has ever deployed (enumerate via {cloneAt}).
    function cloneCount() external view returns (uint256) {
        return _clones.length;
    }

    /// @notice The clone address at enumeration index `i`.
    function cloneAt(uint256 i) external view returns (address) {
        return _clones[i];
    }

    // ---------------------------------------------------------------------------------------------
    // Upgradeability
    // ---------------------------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Reserved storage so a future version can add fields without shifting the layout of anything
    /// declared after this contract in an upgrade.
    uint256[44] private __gap;
}

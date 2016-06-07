'use strict';

const fs = require( 'fs' );
const path = require( 'path' );
const yaml = require( 'js-yaml' );
const defaultOptions = require( '../default-options' );
const utils = require( './utils' );
const C = require( '../constants/constants' );
const LOG_LEVEL_KEYS = Object.keys( C.LOG_LEVEL );

/**
 * Reads and parse a general configuraiton file content.
 *
 * @param {String} filePath
 * @param {Function} callback
 *
 * @public
 * @returns {void}
 */
module.exports.readAndParseFile = function( filePath, callback ) {
	try {
		fs.readFile( filePath, 'utf8', function( error, fileContent ) {
			if ( error ) {
				return callback ( error );
			}
			try {
				const config = parseFile( filePath, fileContent );
				return callback( null, config );

			} catch ( error ) {
				return callback ( error );
			}
		} );
	} catch ( error ) {
		return callback ( error );
	}
};

/**
 * Parse a general configuration file
 * These file extension ans formats are allowed:
 * .yml, .js, .json
 *
 * If no fileContent is passed the file is read synchronously
 *
 * @param {String} filePath
 * @param {String} fileContent
 *
 * @private
 * @returns {Object} config
 */
function parseFile( filePath, fileContent ) {
	if ( fileContent == null ) {
		fileContent = fs.readFileSync( filePath, {encoding: 'utf8'} );
	}
	let config = null;
	const extension = path.extname( filePath );

	if ( extension === '.yml' ) {
		config = yaml.safeLoad( fileContent );
	} else if ( extension === '.js' ) {
		config = require( path.resolve( filePath ) );
	} else if ( extension === '.json' ) {
		config = JSON.parse( fileContent );
	} else {
		throw new Error( extension + ' is not supported as configuration file' );
	}

	return config;
}

/**
 * Loads a file as deepstream config. CLI args have highest priority after the
 * configuration file. If some properties are not set they will be defaulted
 * to default values defined in the defaultOptions.js file.
 * Configuraiton file will be transformed to a deepstream object by evaluating
 * some properties like the plugins (logger and connectors).
 *
 * @param {String} customFilePath
 *
 * @public
 * @returns {Object} config
 */
module.exports.loadConfig = function( argv ) {
	if ( typeof argv === 'string' ) {
		// backwards compatibility for the tests
		argv = {
			config: argv,
			libPrefix: process.cwd()
		};
	} else if ( argv == null ) {
		argv = {};
	}
	var _configFile = argv.c || argv.config;
	var _libPrefix = argv.l || argv.libPrefix;

	var cliOptions = {
		configPrefix: process.cwd(),
		libPrefix: process.cwd()
	};

	var customFilePath = undefined;
	if( _configFile ) {
		customFilePath = _configFile;
		cliOptions.configPrefix = path.dirname( _configFile );
		cliOptions.libPrefix = cliOptions.configPrefix
	}
	if ( _libPrefix ) {
		cliOptions.libPrefix = _libPrefix;
	}
	const filePath = findFilePath( customFilePath );
	if ( filePath == null ) {
		return {
			config: defaultOptions.get(),
			file: 'default options'
		};
	}
	const config = parseFile( filePath );
	// CLI arguments
	var cliArgs = {};
	for ( let key in Object.keys( defaultOptions.get() ) ) {
		cliArgs[key] = argv[key] || undefined;
	}

	var result = handleMagicProperties( utils.merge( {}, defaultOptions.get(), config, cliArgs ), cliOptions );
	return {
		config: result,
		file: filePath
	};
};

/**
 * Does lookups for the depstream configuration file.
 * Lookup order: config.json, config.js, config.yml
 * The order will be ignored if customFilePath  will be passed.
 *
 * @param {String} customFilePath
 *
 * @private
 * @returns {String} filePath
 */
function findFilePath( customFilePath ) {
	const order = [
		'config.json',
		'config.js',
		'config.yml'
	];
	let filePath = null;

	if ( customFilePath != null ) {
		try {
			fs.lstatSync( customFilePath );
			filePath = customFilePath;
		} catch ( err ) {
			throw new Error( 'configuration file not found at: ' + customFilePath );
		}
	} else {
		filePath = order.filter( function( filePath ) {
			try {
				fs.lstatSync( filePath );
				return true;
			} catch ( err ) {}
		} )[ 0 ];
	}
	return filePath;
}

/**
 * Handle configuration properties which are transformed into non trivial
 * data types
 *
 * @param {Object} config
 *
 * @private
 * @returns {void}
 */
function handleMagicProperties( cfg, cliOptions ) {
	const config = utils.merge( {
		plugins: {}
	}, cfg );

	handleUUIDProperty( config );
	handleLogLevel( config );
	handlePlugins( config, cliOptions );

	return config;
}

/**
 * Transform the UUID string config to a UUID in the config object.
 *
 * @param {Object} config
 *
 * @private
 * @returns {void}
 */
function handleUUIDProperty( config ) {
	if ( config.serverName === 'UUID' ) {
		config.serverName = utils.getUid();
	}
}

/**
 * Transform log level string (enum) to its internal value
 *
 * @param {Object} config
 *
 * @private
 * @returns {void}
 */
function handleLogLevel( config ) {
	if ( LOG_LEVEL_KEYS.indexOf( config.logLevel ) !== -1 ) {
		config.logLevel = C.LOG_LEVEL[ config.logLevel ];
	}
}

/**
 * Handle the plugins property in the config object
 * for logger and the connectors.
 * Modifies the config object and load the logger and connectors
 * and passing options for the connectors
 * Plugins can be passed either as a `path` property  - a relative to the
 * working directory, or the npm module name - or as a `name` property with
 * a naming convetion: `{message: {name: 'redis'}}` will be resolved to the
 * npm module `deepstream.io-msg-direct`
 *
 * @param {Object} config
 *
 * @private
 * @returns {void}
 */
function handlePlugins( config, cliOptions ) {
	var connectors = [
		'messageConnector',
		'cache',
		'storage'
	];
	var plugins = {
		logger: config.plugins.logger,
		messageConnector: config.plugins.message,
		cache: config.plugins.cache,
		storage: config.plugins.storage
	};
	for ( let key in plugins ) {
		var plugin = plugins[key];
		if ( plugin != null ) {
			var fn = null;
			if ( plugin.path != null ) {
				var requirePath;
				if ( plugin.path[ 0 ] !== '.' ) {
					requirePath = plugin.path;
				} else {
					if ( cliOptions.libPrefix[ 0 ] === '/' ) {
						requirePath = path.join( cliOptions.libPrefix, plugin.path );
					} else {
						requirePath = path.join( process.cwd(), cliOptions.libPrefix, plugin.path );
					}
				}
				// plugin.path : path.join( process.cwd(), plugin.path );
				fn = require( requirePath );
			} else if ( plugin.name != null ) {
				var connectorKey = key;
				if ( connectors.indexOf( connectorKey ) !== -1 ) {
					if ( connectorKey === 'messageConnector' ) {
						connectorKey = 'msg';
					}
					fn = require( 'deepstream.io-' + connectorKey + '-' + plugin.name );
				} else if ( key === 'logger' && plugin.name === 'default' ) {
					fn = require( '../default-plugins/std-out-logger' );
				}
			}
			if ( key === 'logger' ) {
				config[key] = fn;
			} else {
				config[key] = new fn( plugin.options );
			}
		}
	}
}

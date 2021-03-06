var http = require( 'http' );
var URL = require( 'url' );
var PATH = require( 'path' );
var fs = require( 'fs' );
var mime = require( './lib/mime' );
var MessageBus = require( './lib/messagebus' );

var httpProxy = require('http-proxy');

//var config = require( './config/config2.js' );

var config;
var args = process.argv.slice( 2 );

if ( args[ 0 ] ) {
    var configPath = args[ 0 ];
    if ( /^[^\.\/]/.test( configPath ) ) {
        configPath = './' + configPath;
    }
    config = require( configPath );
} else {
    config = require( './config' );
}


var proxy = httpProxy.createProxyServer();

proxy.on( 'error', function ( err ) {
    console.log( 'proxy error...' );
    console.log( arguments.length );
} );

var app = {

    config: config,

    parseUrl: function ( url ) {
        var url = URL.parse( url );
        url.extname = PATH.extname( url.pathname )

        return url;
    },

    responseConcatFile: function ( req, res, serverConfig, urlInfo ) {

        var pathname = urlInfo.pathname;
        if ( typeof serverConfig.rewrite == 'function' ) {
            pathname = serverConfig.rewrite( pathname, req );
        }
        
        var contentType = mime[ urlInfo.extname ];
        var mb = new MessageBus();
        var files = serverConfig.concatFile[ pathname ];
        
        var files = files.map( function ( file ) {
            return PATH.join( serverConfig.root, file );
        } );

        var array = [];
        var hasError = false;

        mb.wait( files, function () {

            res.writeHead( 200, { 'content-type' : contentType } );
            array.forEach( function ( data ) {
                res.write( data );
            } );
            res.end();
        } );

        files.forEach( function ( file, index ) {
            
            fs.readFile( file, function ( err, data ) {

                if ( hasError ) {
                    return;
                }

                if ( err ) {
                    hasError = true;
                    app.responseSingleFile( req, res, serverConfig, urlInfo );
                } else {
                    array[ index ] = data;
                    mb.publish( file );
                }
            } );
        } );
    },

    responseSingleFile: function ( req, res, serverConfig, urlInfo ) {

        var contentType = mime[ urlInfo.extname ];
        var originFile = PATH.join( serverConfig.root, urlInfo.pathname );

        var filename = urlInfo.pathname;

        if ( typeof serverConfig.rewrite == 'function' ) {
            filename = serverConfig.rewrite( filename, req );
        }

        filename = PATH.join( serverConfig.root, filename );

        var extname = PATH.extname( filename ).toLowerCase();

        var readbleExts = [ '.js' ];

        if ( readbleExts.indexOf( extname ) != -1 ) { //全部读到内存中再response

            fs.open( filename, 'r', function ( err, fd ) {
                if ( err ) {
                    if ( filename == originFile ) {
                        app.proxyTo( req, res, serverConfig );
                    } else {
                        fs.open( originFile, 'r', function ( err, fd ) {

                            if ( err ) {
                                app.proxyTo( req, res, serverConfig );
                            } else {

                                fs.readFile( originFile, function ( err, data ) {

                                    if ( err ) {
                                        app.proxyTo( req, res, serverConfig );
                                    } else {

                                        var charset = 'utf-8';
                                        if ( data.toString( charset ).indexOf( '�' ) != -1 ) {
                                            charset = 'gbk';
                                        }
                                        contentType = contentType + ';charset=' + charset;

                                        res.writeHead( 200, { 'content-type' : contentType } );
                                        res.end( data, 'binary' );
                                        fs.close( fd );
                                    }

                                } );
                            }

                        } );
                    }
                } else {
                    
                    fs.readFile( filename, function ( err, data ) {

                        if ( err ) {
                            app.proxyTo( req, res, serverConfig );
                        } else {

                            var charset = 'utf-8';
                            if ( data.toString( charset ).indexOf( '�' ) != -1 ) {
                                charset = 'gbk';
                            }
                            contentType = contentType + ';charset=' + charset;

                            res.writeHead( 200, { 'content-type' : contentType } );
                            res.end( data, 'binary' );
                            fs.close( fd );
                        }

                    } );
                }

            } );

        } else { //用流的方式response

            fs.open( filename, 'r', function ( err, fd ) {

                var stream;

                if ( err ) {
                    if ( filename == originFile ) {
                        app.proxyTo( req, res, serverConfig );
                    } else {
                        fs.open( originFile, 'r', function ( err, fd ) {
                            if ( err ) {
                                app.proxyTo( req, res, serverConfig );
                            } else {
                                res.writeHead( 200, { 'content-type' : contentType } );

                                stream = fs.createReadStream( filename );
                                stream.on( 'data', function ( data ) {
                                    res.write( data );
                                } );

                                stream.on( 'end', function () {
                                    res.end();
                                    fs.close( fd );
                                } );
                            }
                        } );
                    }
                } else {

                    res.writeHead( 200, { 'content-type' : contentType } );

                    stream = fs.createReadStream( filename );
                    stream.on( 'data', function ( data ) {
                        res.write( data );
                    } );

                    stream.on( 'end', function () {
                        res.end();
                        fs.close( fd );
                    } );
                }

            } );
        }
    },

    proxyTo: function ( req, res, serverConfig ) {
    
        if ( !serverConfig.proxy_pass ) {
            res.writeHead( 404, { 'content-type' : 'text/plain' } );
            res.end( 'not found: no proxy_pass_server' );
        }

        proxy.web( req, res, {
            target: serverConfig.proxy_pass
        } );
    },

    handler: function ( req, res ) {

        var config = app.config;
        var host = req.headers.host.split( ':' )[ 0 ];    

        var serverConfig;

        config.servers.every( function ( item ) {
            if ( item.name == host ) {
                serverConfig = item;
                return false;
            }
            return true;
        } );
        
        if ( !serverConfig ) {
            res.writeHead( 500, { 'content-type' : 'text/plain' } );
            res.end( 'no server' );
            return;
        }

        if ( req.method == 'POST' ) {
            app.proxyTo( req, res, serverConfig );
            return;
        }

        var urlInfo = app.parseUrl( req.url );
        var pathname = urlInfo.pathname;

        if ( typeof serverConfig.rewrite == 'function' ) {
            pathname = serverConfig.rewrite( pathname, req );
        }

        urlInfo.extname = PATH.extname( pathname );

        if ( !mime[ urlInfo.extname ] ) {
            app.proxyTo( req, res, serverConfig );
            return;
        }

        if ( serverConfig.concatFile && serverConfig.concatFile[ pathname ] ) {
            app.responseConcatFile( req, res, serverConfig, urlInfo );
        } else {
            app.responseSingleFile( req, res, serverConfig, urlInfo );
        }
    },

    init: function () {

        var config = this.config;

        this.server = http.createServer( this.handler.bind( this ) );

        if ( config.host ) {
            this.server.listen( config.port || 80, config.host );
        } else {
            this.server.listen( config.port || 80 );
        }

        this.server.on( 'clientError', function ( err, socket ) {
            console.log( new Date() );
            console.log( err );
            console.log( err.stack );
            socket.destroy();
        } );

        if ( config.pid ) {
            fs.writeFile( config.pid, process.pid );
        }
        console.log( 'listening on \d', config.port || 80 );
    }
};

app.init();

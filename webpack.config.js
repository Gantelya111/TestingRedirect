import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    mode: 'development',
    entry: {
        'p2p-app': './src/p2p-app-src.js',
        'manager': './src/manager-src.js',
        'edit-redirect': './src/edit-redirect-src.js',
        'p2p': './src/p2p.js'
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'public'),
        publicPath: '/',
        clean: true
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: 'defaults',
                                    modules: false,
                                    useBuiltIns: 'usage',
                                    corejs: '3.38'
                                }
                            ]
                        ],
                        sourceType: 'unambiguous'
                    }
                }
            }
        ]
    },
    resolve: {
        extensions: ['.js', '.mjs'],
        fallback: {
            crypto: 'crypto-browserify',
            stream: 'stream-browserify',
            buffer: 'buffer',
            assert: 'assert',
            util: 'util',
            url: 'url',
            path: 'path-browserify',
            os: 'os-browserify/browser',
            https: 'https-browserify',
            http: 'stream-http',
            vm: 'vm-browserify',
            process: 'process/browser.js'
        },
        alias: {
            'process/browser': 'process/browser.js'
        }
    },
    plugins: [
        new webpack.ProvidePlugin({
            process: ['process/browser.js', 'default'],
            Buffer: ['buffer', 'Buffer']
        }),
        new webpack.IgnorePlugin({
            resourceRegExp: /^(dgram|net|tls|dns|fs)$/
        }),
        new webpack.DefinePlugin({
            'process.env.NODE_ENV': JSON.stringify('development'),
            'process.browser': JSON.stringify(true)
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'src/html', to: '.' },
                { from: 'src/html/favicon.ico', to: 'favicon.ico' }
            ]
        })
    ],
    devtool: 'eval-source-map',
    performance: {
        hints: false,
        maxAssetSize: 1000000,
        maxEntrypointSize: 1000000
    },
    stats: 'verbose',
    target: 'web'
};

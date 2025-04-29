import path from 'path';
import { fileURLToPath } from 'url';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    mode: process.env.NODE_ENV || 'production',
    entry: {
        'manager': './src/manager-src.js',
        'edit-redirect': './src/edit-redirect-src.js',
        'redirect': './src/redirect-src.js'
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
                                    useBuiltIns: 'usage',
                                    corejs: '3.38'
                                }
                            ]
                        ]
                    }
                }
            }
        ]
    },
    resolve: {
        extensions: ['.js']
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                { from: 'src/html/index.html', to: 'index.html' },
                { from: 'src/html/edit-redirect.html', to: 'edit-redirect.html' },
                { from: 'src/html/redirect.html', to: 'redirect.html' },
                { from: 'src/html/favicon.ico', to: 'favicon.ico' }
            ]
        })
    ],
    devtool: process.env.NODE_ENV === 'development' ? 'eval-source-map' : 'source-map',
    performance: {
        hints: false,
        maxAssetSize: 1000000,
        maxEntrypointSize: 1000000
    },
    stats: 'verbose',
    target: 'web'
};
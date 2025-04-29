import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default (env, argv) => {
    const mode = argv.mode || 'development';
    return {
        mode,
        entry: {
            'p2p-app': './src/p2p-app-src.js',
            'manager': './src/manager-src.js',
            'edit-redirect': './src/edit-redirect-src.js',
            'p2p': './src/p2p.js',
        },
        output: {
            filename: '[name].js',
            path: path.resolve(__dirname, 'public'),
            publicPath: '/',
            clean: true,
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
                                        corejs: '3.38',
                                    },
                                ],
                            ],
                            sourceType: 'unambiguous',
                        },
                    },
                },
            ],
        },
        resolve: {
            extensions: ['.js'],
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
                process: 'process/browser',
                dgram: false,
                net: false,
                tls: false,
                dns: false,
                fs: false,
            },
            alias: {
                'process/browser': 'process/browser',
            },
        },
        plugins: [
            new webpack.ProvidePlugin({
                process: ['process/browser', 'default'],
                Buffer: ['buffer', 'Buffer'],
            }),
            new webpack.IgnorePlugin({
                resourceRegExp: /^(dgram|net|tls|dns|fs)$/,
            }),
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode),
                'process.browser': JSON.stringify(true),
            }),
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                openAnalyzer: false,
                reportFilename: 'report.html',
            }),
            new CopyWebpackPlugin({
                patterns: [
                    { from: 'src/html', to: '.' },
                    { from: 'src/html/favicon.ico', to: 'favicon.ico' },
                ],
            }),
        ],
        devtool: mode === 'production' ? 'source-map' : 'eval-source-map',
        performance: {
            hints: false,
            maxAssetSize: 1000000,
            maxEntrypointSize: 1000000,
        },
        stats: 'verbose',
        cache: {
            type: 'filesystem',
            cacheDirectory: path.resolve(__dirname, '.webpack_cache'),
        },
        target: 'web',
    };
};

const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  entry: './src/app.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        use: {
          loader: 'babel-loader',
          options: {
            plugins: ['@babel/plugin-transform-block-scoping'],
            compact: false
          }
        },
        resolve: { fullySpecified: false }
      }
    ]
  },
  resolve: {
    fallback: {
      crypto: false, stream: false, buffer: false,
      path: false, fs: false, os: false
    }
  },
  plugins: [new HtmlWebpackPlugin({ template: './index.html' })],
  optimization: { concatenateModules: false, usedExports: false, minimize: false },
  experiments: { topLevelAwait: true },
  devServer: {
    port: 3000,
    hot: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
}

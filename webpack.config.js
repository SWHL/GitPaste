// @ts-check
'use strict'

const path = require('path')

/** @type {import('webpack').Configuration} */
const webExtension = {
  target: 'webworker',
  entry: {
    extension: './src/extension.ts',
    'test/suite/index': './test/web/index.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist/web'),
    filename: '[name].js',
    libraryTarget: 'commonjs',
    devtoolModuleFilenameTemplate: '../../[resource-path]'
  },
  devtool: 'nosources-source-map',
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader'
      }
    ]
  },
  performance: {
    hints: false
  }
}

module.exports = webExtension

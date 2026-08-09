// The seed for aliases.json: names that have actually been confused with
// another package, mapped to what the author almost certainly meant.
//
// Most of this list is history rather than guesswork. The 2017 registry
// sweep that removed dozens of packages named after popular ones -- and
// every incident since that followed the same shape -- left a public record
// of which names people really do type by mistake. Those are recorded here.
// The rest are short-name confusions where a plugin's install name and the
// name it is configured under differ ("unused-imports" against
// "eslint-plugin-unused-imports"), which is a mistake made from memory
// rather than from mistyping.
//
// The alias rule is the one typosquat rule that reports critical without
// qualification, because a curated pair is a fact rather than a
// resemblance. That is also what makes the constraint below absolute.

export const ALIAS_SEED = Object.freeze({
  // Registry incidents: names published to shadow a popular package.
  babelcli: ['babel-cli'],
  crossenv: ['cross-env'],
  'cross-env.js': ['cross-env'],
  'd3.js': ['d3'],
  'fabric-js': ['fabric'],
  ffmepg: ['ffmpeg'],
  gruntcli: ['grunt-cli'],
  'http-proxy.js': ['http-proxy'],
  'jquery.js': ['jquery'],
  mongose: ['mongoose'],
  mongoosee: ['mongoose'],
  'mssql.js': ['mssql'],
  'mssql-node': ['mssql'],
  mysqljs: ['mysql'],
  'node-fabric': ['fabric'],
  'node-opencv': ['opencv'],
  'node-opensl': ['openssl'],
  'node-openssl': ['openssl'],
  'node-sqlite': ['sqlite3'],
  nodecaffe: ['coffee-script'],
  nodefabric: ['fabric'],
  'nodemailer-js': ['nodemailer'],
  nodemssql: ['mssql'],
  noderequest: ['request'],
  nodesass: ['node-sass'],
  nodesqlite: ['sqlite3'],
  'opencv.js': ['opencv'],
  'openssl.js': ['openssl'],
  'proxy.js': ['http-proxy'],
  shadowsock: ['shadowsocks'],
  'sqlite.js': ['sqlite3'],
  sqliter: ['sqlite3'],
  sqlserver: ['mssql'],

  // Mistypings of names common enough that the typo is common too. The
  // transform rules would catch several of these on their own; listing them
  // here promotes the finding from a resemblance to a known pair.
  axois: ['axios'],
  electorn: ['electron'],
  expresss: ['express'],
  loadash: ['lodash'],
  lodahs: ['lodash'],
  momnet: ['moment'],
  reactt: ['react'],
  typescritp: ['typescript'],
  typscript: ['typescript'],
  webpakc: ['webpack'],

  // Configured-name against installed-name confusions. An eslint plugin is
  // referenced in config by its short name and installed under its full
  // one, and the short name is what gets typed into package.json.
  'unused-imports': ['eslint-plugin-unused-imports'],
  'import-resolver-typescript': ['eslint-import-resolver-typescript'],
  'jsx-a11y': ['eslint-plugin-jsx-a11y'],
  'react-hooks': ['eslint-plugin-react-hooks'],
  'config-conventional': ['@commitlint/config-conventional'],
});

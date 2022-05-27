const os = require('os')

// Unbundles the published packages output from changesets action
data = process.argv[2]
data = JSON.parse(data)

for (const i of data) {
  const name = i.name.replace("@chainlink-sol-fork/", "")
  const version = i.version
  process.stdout.write(`::set-output name=${name}::${version}` + os.EOL)
}
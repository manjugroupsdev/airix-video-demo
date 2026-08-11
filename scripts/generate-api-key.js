import crypto from 'node:crypto'

const id = process.argv[2] || 'product'
const name = process.argv.slice(3).join(' ') || id
const key = `ak_live_${crypto.randomBytes(32).toString('base64url')}`
const webhookSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`
const keyHash = crypto.createHash('sha256').update(key).digest('hex')

console.log(
  JSON.stringify(
    {
      apiKey: key,
      envConfig: {
        id,
        keyHash,
        name,
        webhookSecret,
        webhookUrl: '',
      },
    },
    null,
    2,
  ),
)

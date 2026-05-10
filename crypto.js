// AES-256-GCM encrypt/decrypt helpers.
// Wire format: [ 12 bytes IV | 16 bytes authTag | N bytes ciphertext ]

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

export function encrypt(plaintext, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decrypt(data, key) {
  const iv      = data.subarray(0, 12)
  const authTag = data.subarray(12, 28)
  const enc     = data.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(enc), decipher.final()])
}

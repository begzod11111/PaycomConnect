#!/usr/bin/env node
// Генерирует ключ сервис-клиента: 36 символов (латиница в обоих регистрах + цифры).
// Использование:
//   node ./scripts/gen-service-key.js           -> печатает один ключ
//   node ./scripts/gen-service-key.js balancer  -> печатает пару "balancer:<ключ>"
//                                                   (готово для SERVICE_CLIENTS)
import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_LENGTH = 36;

function generateKey(length = KEY_LENGTH) {
  let key = '';
  for (let i = 0; i < length; i += 1) {
    key += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return key;
}

const clientName = process.argv[2];
const key = generateKey();

if (clientName) {
  console.log(`${clientName}:${key}`);
} else {
  console.log(key);
}

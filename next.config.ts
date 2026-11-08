import type { NextConfig } from 'next';
const config: NextConfig = { distDir: process.env.AGENT_TEST_MODE ? '.next-qa' : '.next', serverExternalPackages: ['node:sqlite','@huggingface/transformers','onnxruntime-node'], poweredByHeader: false };
export default config;

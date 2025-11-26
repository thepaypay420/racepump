#!/bin/bash

# PumpBets Deployment Build Script
# Fixes ESBuild crashes, BigInt bindings, and memory issues

echo "🔧 Starting PumpBets deployment build with fixes..."

# Set memory limits for build process
export NODE_OPTIONS="--max-old-space-size=4096"

echo "📦 Rebuilding native dependencies (BigInt bindings fix)..."
npm rebuild better-sqlite3 || echo "⚠️ better-sqlite3 rebuild failed, continuing..."

echo "🏗️ Running Vite build with increased memory..."
NODE_OPTIONS="--max-old-space-size=4096" npm run build

echo "✅ Build complete!"
echo "🚀 To start in production: NODE_OPTIONS='--max-old-space-size=2048' npm start"
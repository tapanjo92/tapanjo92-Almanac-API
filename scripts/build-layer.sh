#!/bin/bash

# Build Lambda Layer
echo "Building Lambda layer..."

cd layers/shared-deps/nodejs
pnpm install --prod
cd ../../..

echo "Lambda layer built successfully!"
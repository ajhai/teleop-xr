#!/bin/bash
# Script to generate self-signed certificates for local development

# Create certs directory if it doesn't exist
mkdir -p certs

# Generate a private key and self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName = DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"

echo "Self-signed certificates generated successfully!"
echo "cert.pem and key.pem have been placed in the 'certs' directory." 
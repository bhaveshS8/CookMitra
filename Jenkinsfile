pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Setup Environment') {
            steps {
                // Production .env must come from the server or Jenkins credentials —
                // NEVER from hardcoded values in this file (a committed secret
                // compromises every session it ever signed). Values are validated
                // below; nothing secret is ever echoed to the build log.
                sh '''
                set -eu
                if [ ! -f .env ]; then
                    if [ -f /home/ubuntu/CookMitra/.env ]; then
                        cp /home/ubuntu/CookMitra/.env .env
                    elif [ -f /etc/cookmitra/.env ]; then
                        cp /etc/cookmitra/.env .env
                    else
                        echo "ERROR: no .env found. Place a production .env on the server"
                        echo "(/home/ubuntu/CookMitra/.env or /etc/cookmitra/.env), created from"
                        echo "backend/.env.example with REAL secrets (JWT_SECRET, MONGODB_URI,"
                        echo "RAZORPAY_KEY_ID/SECRET, RAZORPAY_WEBHOOK_SECRET, SMTP_*)."
                        echo "CI will never fabricate secrets — refusing to deploy." >&2
                        exit 1
                    fi
                fi
                # Fail fast on missing/weak secrets (length only — values stay hidden).
                JWT_LEN=$(grep -E '^JWT_SECRET=' .env | head -n 1 | cut -d '=' -f2- | wc -m)
                if [ "$JWT_LEN" -lt 33 ]; then
                    echo "ERROR: JWT_SECRET missing or shorter than 32 chars in .env." >&2
                    echo "Generate one with: node backend/scripts/rotate-secrets.js" >&2
                    exit 1
                fi
                if grep -Eq '^JWT_SECRET=(your_|changeme|example|REPLACE_ME)' .env; then
                    echo "ERROR: JWT_SECRET is still a placeholder. Rotate it before deploying." >&2
                    exit 1
                fi
                if ! grep -Eq '^MONGODB_URI=.+' .env; then
                    echo "ERROR: MONGODB_URI is missing in .env." >&2
                    exit 1
                fi
                echo "Secrets present (values hidden from log)."

                # Ensure MONGODB_URI exists in .env if missing
                if ! grep -q "MONGODB_URI" .env; then
                    echo "MONGODB_URI=mongodb://db:27017/festivecook" >> .env
                fi

                # Ensure REACT_APP_GOOGLE_CLIENT_ID exists in .env for frontend build
                if ! grep -q "REACT_APP_GOOGLE_CLIENT_ID" .env && grep -q "GOOGLE_CLIENT_ID=" .env; then
                    GOOGLE_ID=$(grep "GOOGLE_CLIENT_ID=" .env | head -n 1 | cut -d '=' -f2)
                    echo "REACT_APP_GOOGLE_CLIENT_ID=${GOOGLE_ID}" >> .env
                fi
                '''
            }
        }

        stage('Build & Deploy') {
            steps {
                // Cleanly stop existing containers and launch fresh deployment
                sh '''
                docker compose --profile local-mongo down || true
                docker compose --profile local-mongo up --build -d --remove-orphans
                '''
            }
        }

        stage('Health Check') {
            steps {
                // Verify API and database connectivity with retry loop
                sh '''
                for i in $(seq 1 12); do
                    if curl -sf http://localhost:5000/api/health; then
                        echo "App is healthy and responding!"
                        exit 0
                    fi
                    echo "Waiting for app to start (attempt $i/12)..."
                    sleep 5
                done
                echo "Health check failed after 60s"
                exit 1
                '''
            }
        }
    }

    post {
        always {
            // Remove dangling image layers to save disk space
            sh 'docker image prune -f'
        }
    }
}

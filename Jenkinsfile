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
                // Ensure production .env is present with all required variables
                sh '''
                if [ ! -f .env ]; then
                    if [ -f /home/ubuntu/CookMitra/.env ]; then
                        cp /home/ubuntu/CookMitra/.env .env
                    elif [ -f /etc/cookmitra/.env ]; then
                        cp /etc/cookmitra/.env .env
                    else
                        echo "Creating production .env with required keys..."
                        cat << 'EOF' > .env
NODE_ENV=production
PORT=5000
MONGODB_URI=mongodb://db:27017/festivecook
JWT_SECRET=1b30c4959bd46de8851dc3de1bae301ad5cdbca32c4bc7ea86d6f210c8f87fb513f0f8949d052951e0e472aa8dff3a55
GOOGLE_CLIENT_ID=340655287478-iekv29j414nukq16vq04c8v38aou78qd.apps.googleusercontent.com
REACT_APP_GOOGLE_CLIENT_ID=340655287478-iekv29j414nukq16vq04c8v38aou78qd.apps.googleusercontent.com
ALLOW_TEST_PAYMENTS=true
RAZORPAY_KEY_ID=rzp_test_sampleKey123
RAZORPAY_KEY_SECRET=sampleSecretKey123
REACT_APP_RAZORPAY_KEY_ID=rzp_test_sampleKey123
RAZORPAY_CURRENCY=INR
REACT_APP_API_URL=/api
EOF
                    fi
                fi

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

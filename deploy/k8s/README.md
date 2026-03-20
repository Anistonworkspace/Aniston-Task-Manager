# Kubernetes Deployment Guide

## Prerequisites

- AWS EKS cluster or self-managed K8s cluster
- `kubectl` configured to connect to your cluster
- Nginx Ingress Controller installed
- Docker images pushed to a container registry (GHCR, ECR, or DockerHub)

## Step 1: Create Namespace

```bash
kubectl apply -f deploy/k8s/namespace.yml
```

## Step 2: Create Secrets (from your .env file)

```bash
kubectl create secret generic aniston-hub-secrets \
  --from-literal=DB_PASSWORD='YourStrongPassword' \
  --from-literal=JWT_SECRET='YourJWTSecret' \
  --from-literal=TEAMS_CLIENT_ID='your-id' \
  --from-literal=TEAMS_CLIENT_SECRET='your-secret' \
  --from-literal=TEAMS_TENANT_ID='your-tenant' \
  --from-literal=VAPID_PUBLIC_KEY='your-key' \
  --from-literal=VAPID_PRIVATE_KEY='your-key' \
  -n aniston-apps
```

## Step 3: Apply ConfigMap

```bash
kubectl apply -f deploy/k8s/configmap.yml
```

## Step 4: Deploy PostgreSQL

```bash
kubectl apply -f deploy/k8s/postgres.yml
# Wait for pod to be ready:
kubectl wait --for=condition=ready pod -l app=postgres -n aniston-apps --timeout=120s
```

## Step 5: Deploy Backend + Frontend

```bash
kubectl apply -f deploy/k8s/backend.yml
kubectl apply -f deploy/k8s/frontend.yml
```

## Step 6: Setup Ingress (Domain Routing)

```bash
kubectl apply -f deploy/k8s/ingress.yml
```

## Step 7: Seed Database

```bash
# Find backend pod name
POD=$(kubectl get pods -n aniston-apps -l app=aniston-hub-backend -o jsonpath='{.items[0].metadata.name}')

# Run seeds
kubectl exec $POD -n aniston-apps -- node seed-users.js
kubectl exec $POD -n aniston-apps -- node seed-hierarchy.js
```

## Adding More Applications

Edit `deploy/k8s/ingress.yml` to add new host rules:

```yaml
- host: hrms.anistonav.com
  http:
    paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hrms-service
            port:
              number: 80
```

## Useful Commands

```bash
# Check all pods
kubectl get pods -n aniston-apps

# View logs
kubectl logs -f deployment/aniston-hub-backend -n aniston-apps

# Scale backend
kubectl scale deployment aniston-hub-backend --replicas=3 -n aniston-apps

# Rolling update after new image
kubectl rollout restart deployment/aniston-hub-backend -n aniston-apps
kubectl rollout restart deployment/aniston-hub-frontend -n aniston-apps
```

## AWS EKS Setup (Quick Start)

```bash
# Install eksctl
# Create cluster (takes ~15 min)
eksctl create cluster --name aniston-cluster --region ap-south-1 --nodegroup-name workers --node-type t3.medium --nodes 2

# Install Nginx Ingress
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/aws/deploy.yaml

# Then follow Steps 1-7 above
```

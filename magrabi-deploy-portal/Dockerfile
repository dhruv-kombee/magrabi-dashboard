# Magrabi Deploy Portal -- multi-stage build: React frontend, then the Flask backend that serves it.
#
# Stage 1 builds the frontend straight into backend/static (see frontend/vite.config.ts's
# build.outDir) -- stage 2 only needs to copy that directory, no separate nginx process.

FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM python:3.13-slim AS backend
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
# frontend-build's outDir (../backend/static relative to frontend/) lands here at build time too --
# copy explicitly anyway so the image doesn't depend on that side effect.
COPY --from=frontend-build /app/backend/static ./static

# Key Rotation section (MLC-2635): the routing table for the two CI/CD Key Vaults - which secret
# feeds which project, release definition, stage, variable and placement class. Read at
# KEYVAULT_PLAN_DIR, default /app/keyvault.
#
# Baked in rather than mounted, on purpose. These files are DERIVED from the live pipelines by
# enumerate.py -> placement.py -> <env>_scope.py, so a plan belongs to the build it shipped with.
# Mounting a plan that had drifted from the image would silently sync the wrong set of destinations.
# Regenerate the plans and rebuild together.
#
# They live in keyvault/ inside this directory, staged by stage_plans.py, rather than being copied
# from devops-tools/kvsync/. Pointing the build context at the repository root would have worked,
# but it would also have sent .secrets/ to the registry, because .dockerignore only applies at the
# context root. Staging a copy keeps the context small and keeps real credentials out of the image.
#
# The plans contain names only - project, definition, stage, variable, placement, service - and no
# credential value. Checked before baking them in.
COPY keyvault/ ./keyvault/

EXPOSE 5151
CMD ["gunicorn", "--workers", "1", "--threads", "8", "--timeout", "120", "-b", "0.0.0.0:5151", "app:app"]

FROM node:22-alpine AS build
WORKDIR /app
COPY ui/package.json ui/package-lock.json ./ui/
RUN npm ci --prefix ui
COPY packages/shared ./packages/shared
COPY ui ./ui
RUN npm run build:hosted --prefix ui

FROM nginx:alpine
ENV PORT=8080
COPY deploy/hosted-web.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/ui/dist-hosted /usr/share/nginx/html
EXPOSE 8080

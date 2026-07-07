FROM nginx:alpine

# Remove default nginx page
RUN rm /usr/share/nginx/html/index.html

# Build context is the repo root (see docker-compose.lab.yml) so both the
# shared modules and this app's own files can be copied in.
COPY services/shared /usr/share/nginx/html/shared
COPY services/lab-app/index.html /usr/share/nginx/html/index.html
COPY services/lab-app/src /usr/share/nginx/html/src

EXPOSE 80

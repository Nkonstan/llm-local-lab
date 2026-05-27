FROM nginx:alpine

# Remove default nginx page
RUN rm /usr/share/nginx/html/index.html

# Copy our single-file lab UI
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80

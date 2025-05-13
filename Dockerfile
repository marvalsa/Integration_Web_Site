# Usamos la imagen oficial de Node.js basada en Alpine (más ligera)
FROM node:18-alpine

# Establecer el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar package.json y package-lock.json primero para aprovechar el caché de Docker
COPY package*.json ./

# Instalar SOLAMENTE dependencias de producción
RUN npm install --production

# Copiar todos los archivos de la aplicación al contenedor
# Esto incluye tu carpeta 'src', 'logs' (si existe localmente y la necesitas copiar), etc.
COPY . .

# No necesitas EXPOSE si el script no es un servidor web
# EXPOSE 8080

# Comando para iniciar el script de sincronización definido en package.json
CMD ["npm", "run", "sync"]
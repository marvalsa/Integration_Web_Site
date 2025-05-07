# FROM node:18-alpine
# WORKDIR /app
# COPY package*.json ./
# RUN npm install --production
# COPY . .
# CMD ["npm", "run", "main"]

# Usamos la imagen oficial de Node.js basada en Alpine (más ligera)
FROM node:18-alpine

# Establecer el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar package.json y package-lock.json primero para aprovechar el caché de Docker
COPY package*.json ./

# Instalar dependencias en modo producción (evitar dependencias de desarrollo)
RUN npm install --production

# Copiar todos los archivos de la aplicación al contenedor
COPY . .

# Exponer el puerto que la aplicación estará escuchando (asegúrate de que sea el correcto)
EXPOSE 8080

# Comando para iniciar la aplicación
CMD ["npm", "run", "main"]

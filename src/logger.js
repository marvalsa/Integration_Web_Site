// // const fs = require('fs-extra');
// // const path = require('path');

// // // Definir el directorio y el archivo de log
// // const logDir = path.join(__dirname, 'logs');
// // const logFilePath = path.join(logDir, 'sync.log');

// // // Asegurarse de que el directorio de logs existe
// // fs.ensureDirSync(logDir);

// // // Crear un stream de escritura que sobrescriba el archivo existente
// // const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

// // // Guardar las funciones originales de console
// // const originalLog = console.log;
// // const originalError = console.error;

// // // Función para escribir logs con timestamp
// // function writeLog(stream, args) {
// //     const timestamp = new Date().toISOString();
// //     const message = `[${timestamp}] ${args.join(' ')}\n`;

// //     // Escribir en el archivo de log
// //     logStream.write(message);

// //     // Imprimir en la consola
// //     stream.apply(console, args);
// // }

// // // Sobrescribir console.log y console.error
// // console.log = (...args) => writeLog(originalLog, args);
// // console.error = (...args) => writeLog(originalError, args);


// const fs = require('fs');
// // const logFilePath = './logs/sync.log'; // Ruta del archivo de log
// // const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

// const logger = {
//     log: (...args) => writeLog(console.log, args),
//     error: (...args) => writeLog(console.error, args),
//     info: (...args) => writeLog(console.log, args),  // Para info
//     debug: (...args) => writeLog(console.log, args), // Agregar debug
// };

// function writeLog(stream, args) {
//     const timestamp = new Date().toISOString();
//     const message = `[${timestamp}] ${args.join(' ')}\n`;

//     // Escribir en el archivo de log
//     // logStream.write(message);

//     // Imprimir en la consola
//     stream.apply(console, args);
// }

// module.exports = logger;

// const fs = require('fs');
// const path = require('path');

// // Crear carpeta de logs si no existe
// const logDir = path.join(__dirname, 'logs');
// if (!fs.existsSync(logDir)) {
//     fs.mkdirSync(logDir, { recursive: true });
// }

// function createLogger(functionName) {
//     const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // para nombre válido
//     const logFileName = `${functionName}_${timestamp}.log`;
//     const logFilePath = path.join(logDir, logFileName);
//     const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

//     function writeLog(stream, args) {
//         const time = new Date().toISOString();
//         const message = `[${time}] ${args.join(' ')}\n`;

//         // // Escribir en archivo y en consola
//         // logStream.write(message);
//         // stream.apply(console, args);
//     }

//     return {
//         log: (...args) => writeLog(console.log, args),
//         info: (...args) => writeLog(console.log, args),
//         debug: (...args) => writeLog(console.log, args),
//         error: (...args) => writeLog(console.error, args),
//         close: () => logStream.end()
//     };
// }

// module.exports = createLogger;


// //New [15/05/25]
// // // logger.js
// // const fs = require('fs');
// // const path = require('path');

// // // --- PASO 1: Configuración de Rutas y Directorio de Logs ---
// // // Obtiene la ruta del directorio donde se encuentra este archivo (logger.js)
// // const baseDir = __dirname;
// // // Define el nombre de la carpeta de logs y crea la ruta completa
// // // const logDir = path.join(baseDir, 'logs');
// // // // Define la ruta completa para el archivo de log específico
// // // const logFilePath = path.join(logDir, 'sync.log');

// // // // --- PASO 2: Crear la Carpeta de Logs si No Existe ---
// // // // Es importante asegurarse de que el directorio exista antes de intentar escribir un archivo en él.
// // // if (!fs.existsSync(logDir)) {
// // //     try {
// // //         fs.mkdirSync(logDir, { recursive: true }); // recursive: true crea directorios padres si no existen
// // //         console.log(`Directorio de logs creado en: ${logDir}`);
// // //     } catch (err) {
// // //         console.error(`Error al crear el directorio de logs: ${logDir}`, err);
// // //         // Si no se puede crear el directorio, el logger no funcionará para archivos.
// // //         // Podrías optar por salir del proceso o loguear solo a consola.
// // //         process.exit(1); // Salir si no se puede crear el directorio de logs es una opción drástica pero clara.
// // //     }
// // // }

// // // // --- PASO 3: Crear el Stream de Escritura para el Archivo de Log ---
// // // // fs.createWriteStream abre un stream para escribir en el archivo.
// // // // La opción { flags: 'w' } es CRUCIAL:
// // // //  - 'w': Abre el archivo para escritura.
// // // //  - SI EL ARCHIVO EXISTE: Su contenido se TRUNCA (se borra completamente) antes de escribir.
// // // //  - SI EL ARCHIVO NO EXISTE: Se CREA.
// // // // Esto cumple tu requisito de "borrar el anterior y dejar solo el de la nueva ejecución".
// // // let logStream;
// // // try {
// // //     logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
// // //     logStream.on('error', (err) => {
// // //         console.error(`Error en el stream del archivo de log (${logFilePath}):`, err);
// // //         // Aquí podrías implementar un fallback, como loguear solo a consola si el archivo falla.
// // //     });
// // // } catch (err) {
// // //     console.error(`No se pudo crear el stream de escritura para el archivo de log: ${logFilePath}`, err);
// // //     // Si el stream no se puede crear, se logueará solo a consola.
// // // }




// // // --- PASO 5: Función Principal para Escribir el Log ---
// // function writeLog(consoleStreamFunction, level, ...args) {
// //     const timestamp = new Date().toISOString();

// //     // Formatear los argumentos para el mensaje
// //     const messageParts = args.map(arg => {
// //         if (typeof arg === 'object' && arg !== null) {
// //             try {
// //                 // Intentar convertir objetos a JSON string para una mejor legibilidad en el log
// //                 return JSON.stringify(arg, null, 2); // null, 2 para pretty print
// //             } catch (e) {
// //                 return '[Unserializable Object]'; // Manejar objetos que no se pueden serializar
// //             }
// //         }
// //         return String(arg); // Asegurar que todo sea string
// //     });
// //     const message = `[${timestamp}] [${level}] ${messageParts.join(' ')}\n`;

// //     // // Escribir en el archivo de log (si el stream fue creado exitosamente)
// //     // if (logStream) {
// //     //     logStream.write(message, (err) => {
// //     //         if (err) {
// //     //             console.error(`Error al escribir en el archivo de log (${logFilePath}):`, err);
// //     //         }
// //     //     });
// //     // }


// //     // Imprimir en la consola usando la función de consola apropiada (console.log, console.error, etc.)
// //     // Usamos .apply para pasar los argumentos correctamente
// //     consoleStreamFunction.apply(console, [`[${level}]`, ...args]);
// // }

// // // --- PASO 6: Manejar el Cierre del Stream ---
// // // Es una buena práctica cerrar el stream cuando la aplicación termina
// // // para asegurar que todos los datos en buffer se escriban al archivo.
// // function closeLogStream() {
// //     if (logStream) {
// //         logStream.end(() => {
// //             // Opcional: console.log('Stream de log cerrado.');
// //         });
// //     }
// // }

// // // Cuando el proceso está a punto de salir
// // process.on('exit', closeLogStream);

// // // Capturar interrupciones como Ctrl+C
// // process.on('SIGINT', () => {
// //     console.log('\nCerrando logger por SIGINT (Ctrl+C)...');
// //     closeLogStream();
// //     process.exit(0); // Salir explícitamente
// // });

// // // Capturar terminación del proceso (e.g., kill)
// // process.on('SIGTERM', () => {
// //     console.log('Cerrando logger por SIGTERM...');
// //     closeLogStream();
// //     process.exit(0);
// // });

// // // Capturar excepciones no manejadas para intentar loguearlas antes de salir
// // process.on('uncaughtException', (err) => {
// //     console.error('EXCEPCIÓN NO CAPTURADA:');
// //     if (logger && typeof console.error === 'function') {
// //         console.error('Uncaught Exception:', err.message, err.stack);
// //     } else {
// //         // Fallback si el logger no está disponible
// //         const timestamp = new Date().toISOString();
// //         const fallbackMessage = `[${timestamp}] [FATAL_ERROR] Uncaught Exception: ${err.message}\nStack: ${err.stack}\n`;
// //         if (logStream) {
// //             try {
// //                 fs.appendFileSync(logFilePath, fallbackMessage); // Intento desesperado de loguear
// //             } catch (writeErr) {
// //                 console.error("Fallo al escribir la excepción no capturada en el log:", writeErr);
// //             }
// //         }
// //         console.error(err.stack);
// //     }
// //     closeLogStream(); // Intenta cerrar el stream
// //     process.exit(1); // Salir con código de error
// // });


// // // --- PASO 7: Exportar el Logger ---
// // module.exports = logger;
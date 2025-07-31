// src/reportBuilder.js

function crearReporteDeTarea(nombreTarea) {
  return {
    tarea: nombreTarea,
    estado: 'pendiente', // Estados posibles: 'pendiente', 'exitoso', 'finalizado_con_errores', 'error_critico'
    metricas: {
      obtenidos: 0,         // Registros totales leídos de la fuente (Zoho)
      procesados: 0,        // Registros únicos que se intentarán insertar/actualizar
      exitosos: 0,          // Registros guardados correctamente en la BD
      fallidos: 0           // Registros que no se pudieron guardar
    },
    erroresDetallados: []   // Array para guardar mensajes de error específicos
  };
}

module.exports = { crearReporteDeTarea };
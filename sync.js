const MegaSync = require('./src/megaProyectos');
const AttributeSync = require('./src/projectAttributes');
const ZohoToPostgresSyncProjects = require('./src/projects');

(async () => {
    const syncMega = new MegaSync();
    const syncAttributes = new AttributeSync();
    const syncProjects = new ZohoToPostgresSyncProjects();

    await syncAttributes.run();  // Atributos
    await syncMega.run();        // MegaProyectos
    await syncProjects.run();    // Proyectos
})();

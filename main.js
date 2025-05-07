const ZohoToPostgresSync = require('./src/megaProyectos');

(async () => {
    const sync = new ZohoToPostgresSync();
    await sync.run();
})();

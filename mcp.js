'use strict';
/*
 * MCP server for MajaOS. Cursor starts this on the machine where it runs;
 * it signs in to the server and calls the same /api routes as the web interface.
 *
 *   MAJAOS_URL        http://192.168.1.10   (default http://127.0.0.1)
 *   MAJAOS_USER
 *   MAJAOS_PASSWORD
 *   MAJAOS_TOKEN      tb_session cookie, when two-step verification is on
 */
const { serve } = require('./lib/mcp');

if (require.main === module) serve();

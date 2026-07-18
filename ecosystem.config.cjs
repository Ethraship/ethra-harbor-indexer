"use strict";

module.exports = {
  apps: [
    {
      name: "ethra-harbor-indexer",
      script: "npm",
      args: "start",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      time: true,
    },
  ],
};

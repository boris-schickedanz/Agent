module.exports = {
  apps: [{
    name: 'agentcore',
    script: 'src/index.js',
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    // Log management
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Restart policy
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
  }],
};

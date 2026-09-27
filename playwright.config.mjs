import { defineConfig } from '@playwright/test';
const testDB=`test-results/browser-${Date.now()}.sqlite`;
process.env.ZJH_TEST_DB=testDB;
export default defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.mjs',fullyParallel:false,workers:1,timeout:60000,outputDir:'test-results/playwright',globalTeardown:'./tests/browser-teardown.mjs',
  use:{baseURL:'http://127.0.0.1:3101',headless:true,channel:'msedge',trace:'retain-on-failure'},
  webServer:{command:'node server.mjs',url:'http://127.0.0.1:3101/api/bootstrap',reuseExistingServer:false,env:{PORT:'3101',DB_PATH:testDB}},
  reporter:'list'
});

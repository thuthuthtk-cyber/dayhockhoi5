import {
  app,
  analytics,
  db,
  auth,
  firebaseConfig,
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
} from "./firebaseConfig";

export {
  app,
  analytics,
  db,
  auth,
  firebaseConfig,
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
};

export default app;

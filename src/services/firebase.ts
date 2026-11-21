export {
  app,
  analytics,
  db,
  auth,
  firebaseConfig,
  ensureFirebaseAuthSession,
  getLastAuthErrorCode,
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
} from '../firebaseConfig';

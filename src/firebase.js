import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAz0KAAf2l5ouO-JnaSdUOQ8hP8lnn4c-M",
  authDomain: "finefit-timesheet.firebaseapp.com",
  projectId: "finefit-timesheet",
  storageBucket: "finefit-timesheet.firebasestorage.app",
  messagingSenderId: "762608597139",
  appId: "1:762608597139:web:ee76d738bf42f67543b566"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

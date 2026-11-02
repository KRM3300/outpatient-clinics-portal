import { useEffect,useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Navigate,Route,Routes } from 'react-router-dom';
import { supabase } from './lib/supabase';
import Login from './pages/Login';
import PortalHome from './pages/PortalHome';
export default function App(){const [session,setSession]=useState<Session|null>(null);const [ready,setReady]=useState(false);useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true)});const {data}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s));return()=>data.subscription.unsubscribe()},[]);if(!ready)return <main className="center">جاري تحميل البوابة...</main>;return <Routes><Route path="/login" element={session?<Navigate to="/" replace/>:<Login/>}/><Route path="/" element={session?<PortalHome/>:<Navigate to="/login" replace/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes>}

import { mount } from 'svelte';
import App from './App.svelte';
import { createBrowserClient } from './lib/service/client';
import { appContextMap, createAppContext } from './lib/stores/context';
import './lib/tokens.css';

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app');

const client = createBrowserClient();
mount(App, { target, context: appContextMap(createAppContext(client)) });
client.connect();

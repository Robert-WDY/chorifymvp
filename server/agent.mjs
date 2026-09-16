import {Agent as LegacyAgent} from './agent-loop.mjs';
export class Agent extends LegacyAgent{
 constructor(options){super({effectPolicy:'explicit_approval',...options,protocol:'compiled'});}
}

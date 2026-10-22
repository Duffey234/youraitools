# Rebuild src/data/sdn-evm.js from PayGuard's bundled OFAC SDN snapshot (EVM addresses only).
import json, os
src = os.environ.get('PAYGUARD_SDN', '../payguard/src/data/sdn.js')
s = open(src).read()
j = json.loads(s[s.index('{'):s.rstrip().rstrip(';').rindex('}') + 1])
out = {}
for a, refs in j['addresses'].items():
    if a.startswith('0x') and len(a) == 42:
        e = j['entities'].get(refs[0][0], {})
        out[a.lower()] = [e.get('name'), ','.join(e.get('programs', [])), e.get('list_date')]
meta = {'source': j['source'], 'publish_date': j['publish_date'], 'evm_address_count': len(out)}
open(os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'sdn-evm.js'), 'w').write(
    '// GENERATED from x402-payguard src/data/sdn.js (official US Treasury OFAC SDN list): EVM addresses only.\n// [entity, programs, list_date]. Refresh: scripts/build-sdn.py\nexport const SDN_META = ' + json.dumps(meta) + ';\nexport const SDN_EVM = ' + json.dumps(out, separators=(',', ':')) + ';\n')
print(meta)

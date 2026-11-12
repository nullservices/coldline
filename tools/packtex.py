# python tools/packtex.py <dir-with-ambientcg-zips> name=AmbientCgId [...]
# Packs an ambientCG 1K-JPG set into assets/tex/<name>_{c,n,r,ao}.jpg (colour 1024, the rest 512).
import sys, os, zipfile, io
from PIL import Image
src = sys.argv[1]
for arg in sys.argv[2:]:
    name, aid = arg.split('=')
    z = zipfile.ZipFile(os.path.join(src, aid + '.zip'))
    names = z.namelist()
    def get(suffix, size, q):
        n = [x for x in names if x.endswith(suffix)]
        if not n: return False
        im = Image.open(io.BytesIO(z.read(n[0]))).convert('RGB').resize((size, size), Image.LANCZOS)
        im.save(f'assets/tex/{name}_{q}.jpg', quality=82 if q == 'c' else 78, optimize=True); return True
    get('_Color.jpg', 1024, 'c'); get('_NormalGL.jpg', 512, 'n'); get('_Roughness.jpg', 512, 'r'); ao = get('_AmbientOcclusion.jpg', 512, 'ao')
    print(name, aid, 'ao' if ao else 'no-ao')

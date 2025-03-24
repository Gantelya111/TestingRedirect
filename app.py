from quart import Quart, render_template, request, redirect, url_for, flash
import iroh
import hashlib
import random
import asyncio

app = Quart(__name__)
app.secret_key = "supersecretkey"

# Iroh node with multiple peers
bootstrap_peers = [
    "node1.example.com", "node2.example.com", "node3.example.com"
]
iroh_node = iroh.IrohNode(config={"bootstrap_peers": bootstrap_peers})
REDIRECTS_DOC = "redirects_doc"  # Iroh document ID for shared data

cache = {}  # Local cache for faster access

async def sync_redirects():
    global cache
    if not iroh_node.document.exists(REDIRECTS_DOC):
        doc = await iroh_node.document.create(REDIRECTS_DOC)
    else:
        doc = await iroh_node.document.join(REDIRECTS_DOC)
    
    cache = {k.decode(): v.decode() for k, v in (await doc.get_all()).items()}
    
    # Auto-sync updates from the network
    await doc.subscribe(lambda update: cache.update({update.key.decode(): update.value.decode()}))
    return doc

# Generate unique URL
def generate_unique_url(destination_url):
    return hashlib.sha256(
        destination_url.encode() + str(random.random()).encode()
    ).hexdigest()[:6]

@app.route('/')
async def index():
    page = request.args.get('page', 1, type=int)
    per_page = 20
    search_query = request.args.get('search', '', type=str)

    # Fetch all redirects from cache
    all_redirects = [
        {"id": k, "unique_url": v.split("|")[0], "destination_url": v.split("|")[1], "description": v.split("|")[2]}
        for k, v in cache.items()
    ]
    if search_query:
        all_redirects = [r for r in all_redirects if search_query.lower() in r.get("description", "").lower()]

    total_redirects = len(all_redirects)
    start = (page - 1) * per_page
    end = start + per_page
    redirects = all_redirects[start:end]

    return await render_template(
        'index.html',
        redirects=redirects,
        page=page,
        total_redirects=total_redirects,
        per_page=per_page,
        search_query=search_query
    )

@app.route('/add', methods=['POST'])
async def add_redirect():
    form = await request.form
    destination_url = form['destination_url']
    description = form['description']
    if not destination_url:
        flash('Destination URL is required!', 'error')
        return redirect(url_for('index'))

    doc = await sync_redirects()
    unique_url = generate_unique_url(destination_url)
    redirect_id = str(await doc.next_id())  # Hypothetical ID generator
    entry = f"{unique_url}|{destination_url}|{description}"
    await doc.set(redirect_id.encode(), entry.encode())
    cache[redirect_id] = entry  # Update cache

    flash(f'Redirect added! URL: /redirect/{unique_url}', 'success')
    return redirect(url_for('index'))

@app.route('/redirect/<unique_url>')
async def redirect_to_url(unique_url):
    for k, v in cache.items():
        data = v.split("|")
        if data[0] == unique_url:
            return redirect(data[1])
    flash('Invalid unique URL!', 'error')
    return redirect(url_for('index'))

async def main():
    await iroh_node.start()
    await sync_redirects()
    await app.run_task(host='0.0.0.0', port=4999, debug=True)  # Async run

if __name__ == '__main__':
    asyncio.run(main())

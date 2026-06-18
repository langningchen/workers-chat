export async function handleGithubRequest(request, env, path) {
    if (path[0] === "upload") {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        const Image = await request.text();
        let array = new Uint8Array(32);
        crypto.getRandomValues(array);
        let ImageID = Array.from(array, byte => ('0' + byte.toString(16)).slice(-2)).join('').substring(0, 32);
        const ImageData = Image.replace(/^data:image\/\w+;base64,/, '');
        if (!ImageData || ImageData.length === 0) return new Response('Invalid image', { status: 400 });
        try {
            const response = await fetch(new URL('https://api.github.com/repos/' + env.GithubOwner + '/' + env.GithubRepo + '/contents/' + ImageID + '.jpeg'), {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + env.GithubPAT,
                    'Content-Type': 'application/json',
                    'User-Agent': 'chat-image-uploader',
                },
                body: JSON.stringify({
                    message: `Upload from ${request.headers.get('CF-Connecting-IP')}`,
                    content: ImageData
                })
            });
            if (!response.ok) return new Response('Upload failed', { status: 500 });
            return new Response(ImageID, { headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {
            return new Response('Upload failed', { status: 500 });
        }
    } else {
        const ImageID = path[0];
        const clientETag = request.headers.get('If-None-Match');
        const imageETag = `"${ImageID}"`;
        if (clientETag === imageETag) return new Response(null, { status: 304 });
        return await fetch(new URL('https://api.github.com/repos/' + env.GithubOwner + '/' + env.GithubRepo + '/contents/' + ImageID + '.jpeg?1=1'), {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + env.GithubPAT,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'chat-image-uploader',
            },
        }).then(async (res) => {
            if (!res.ok) return new Response('Image not found', { status: 404 });
            return new Response(await res.blob(), {
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'ETag': imageETag
                },
            });
        });
    }
}

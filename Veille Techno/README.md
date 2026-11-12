Je souhaite développer un projet de veille technologique en ce qui concerne les nouveautés technologiques dans les terminaux portuaires du monde. 

Le principe est simple, une fois par semaine je lance un script qui lance un agent IA dont la mission est de récupérer ces actualités dans des sources fiables. Et ensuite de les regrouper de manière intéressante / ludique pour le lecteur. Cette veille techno sera proposée à des CTO de terminaux ou encore à des collaborateurs. 


Je souhaiterais que tu écrives un skill pour un agent Mistral que je lancerais en parralèle avec les tâches suivantes: 

- Parcourir le web, en particulier les sites suivants (Marine Civils Insights, The Motorship Marine Technology: https://www.motorship.com/, World Cargo News https://www.worldcargonews.com/, https://www.porttechnology.org/partner-hub/, Port Strategy: https://www.portstrategy.com/) 
- Récupérer les informations critiques en terme d'avancées technologiques
- Faire un résumé en quelques lignes avec le lien de l'article en suivant un schéma clair du type .json. J'avais les idées suivantes: 
    localisation: (ville, pays ou coordonnées GPS)
    lien: url 
    resumé: en quelques lignes de la situation. 
    lien_previous:lien de l'article précédent si jamais il y a un lien avec un autre.  
    criticality: importance de l'information
    tu es libre de rajouter ce que tu veux
- Claude s'occupera du front. L'idée c'est de upload le json fourni par mistral dans le front et ensuite il y a une mise à jour. 
Mon idée initiale: carte de la terre où on peut hover la souris sur lequel il y a des points rouges (annonces critiques), oranges ou jaunes. Ensuite si on clique sur le lien on est envoyé vers la page de l'article. 

L'idée c'est de garder les anciens articles comme ça si jamais y'a des news updates sur un terminal en rapport avec une info antérieure, ça se met à la suite ce qui crée une sorte de chaîne d'information (c'est pas facile donc autant s'appliquer).  

Tu es complêtement libre pour le front, je pensais html css js et techno web. Si besoin crée des scrips annexes en python. 

Tu peux commencer avec un fake json simulé pour le moment pour le front. TU dois rédiger le skill de l'agent en coordination avec le projet. 

Si tu as encore des questions n'hésite pas. 